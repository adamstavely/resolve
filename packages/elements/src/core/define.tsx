import type { ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/*
 * Thin adapter that exposes a React (shadcn) component as a registered custom element.
 *
 * Decisions recorded in docs/evidence/phase-0-component-gate.md:
 * - Light DOM, no shadow root: label/aria-describedby ID references, Radix portals and Tailwind
 *   styles all require a shared tree. Encapsulation comes from the element contract, not the DOM.
 * - One React runtime for every element (single bundle); one root per element instance.
 * - The element owns state. Components are controlled by element properties and write back
 *   through ctx.set(), so Angular property bindings, attributes and form reset agree.
 */

export type PropType = 'string' | 'boolean' | 'number' | 'json';
export interface PropSpec<T> {
 type: PropType; default: T; attribute?: string | false;
 /** Mirror property writes to the attribute. Needed where the platform reads attributes (e.g. form `disabled`). */
 reflect?: boolean;
}
export type PropSpecs<P> = { [K in keyof P]: PropSpec<P[K]> };

export interface ElementContext<P, E> {
 host: HTMLElement;
 props: Readonly<P>;
 /** True when the element or an ancestor fieldset is disabled. */
 disabled: boolean;
 set<K extends keyof P>(name: K, value: P[K]): void;
 emit<K extends keyof E & string>(name: K, detail: E[K], options?: { cancelable?: boolean }): boolean;
 internals?: ElementInternals;
}

export interface ElementDefinition<P, E> {
 tag: string;
 props: PropSpecs<P>;
 /** Participates in native <form> submission, validation and reset via ElementInternals. */
 formAssociated?: boolean;
 component: ComponentType<ElementContext<P, E>>;
}

const toAttribute = (name: string) => name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

function parse(spec: PropSpec<unknown>, raw: string | null): unknown {
 if (spec.type === 'boolean') return raw !== null;
 if (raw === null) return spec.default;
 if (spec.type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : spec.default; }
 if (spec.type === 'json') { try { return JSON.parse(raw); } catch { return spec.default; } }
 return raw;
}

export function defineElement<P extends object, E extends object>(definition: ElementDefinition<P, E>) {
 const existing = customElements.get(definition.tag);
 if (existing) return existing;
 const specs = definition.props as Record<string, PropSpec<unknown>>;
 const attributeToProp = new Map<string, string>();
 for (const [prop, spec] of Object.entries(specs)) if (spec.attribute !== false) attributeToProp.set(spec.attribute ?? toAttribute(prop), prop);
 const Component = definition.component;

 class ResolveElement extends HTMLElement {
  static formAssociated = !!definition.formAssociated;
  static get observedAttributes() { return [...attributeToProp.keys()]; }
  private values: Record<string, unknown> = Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, s.default]));
  private root?: Root;
  private fieldsetDisabled = false;
  readonly internals?: ElementInternals;

  constructor() {
   super();
   if (definition.formAssociated) this.internals = this.attachInternals();
  }

  connectedCallback() {
   // Properties set before the element was upgraded live on the instance; move them onto the accessors.
   for (const prop of Object.keys(specs)) if (Object.prototype.hasOwnProperty.call(this, prop)) {
    const value = (this as Record<string, unknown>)[prop]; delete (this as Record<string, unknown>)[prop]; (this as Record<string, unknown>)[prop] = value;
   }
   this.root ??= createRoot(this);
   this.render();
  }

  disconnectedCallback() {
   // Moving an element (disconnect then reconnect in the same task) must not discard React state.
   queueMicrotask(() => { if (!this.isConnected) { this.root?.unmount(); this.root = undefined; } });
  }

  attributeChangedCallback(attribute: string, _old: string | null, raw: string | null) {
   const prop = attributeToProp.get(attribute)!;
   this.write(prop, parse(specs[prop], raw));
  }

  formDisabledCallback(disabled: boolean) { this.fieldsetDisabled = disabled; this.render(); }
  formResetCallback() { for (const [prop, spec] of Object.entries(specs)) if (prop === 'value') this.write(prop, spec.default); }

  get form() { return this.internals?.form ?? null; }
  get name() { return this.getAttribute('name') ?? ''; }
  get validity() { return this.internals?.validity; }
  get validationMessage() { return this.internals?.validationMessage ?? ''; }
  get willValidate() { return this.internals?.willValidate ?? false; }
  checkValidity() { return this.internals?.checkValidity() ?? true; }
  reportValidity() { return this.internals?.reportValidity() ?? true; }

  /** Focus the element's primary interactive control. */
  override focus(options?: FocusOptions) { this.querySelector<HTMLElement>('[data-element-focus]')?.focus(options); }

  write(prop: string, value: unknown) {
   if (Object.is(this.values[prop], value)) return;
   this.values[prop] = value;
   const spec = specs[prop];
   if (spec.reflect && spec.type === 'boolean') this.toggleAttribute(spec.attribute || toAttribute(prop), Boolean(value));
   this.render();
  }

  private render() {
   if (!this.root) return;
   const props = { ...this.values } as P;
   const context: ElementContext<P, E> = {
    host: this, props, internals: this.internals,
    disabled: Boolean((props as { disabled?: boolean }).disabled) || this.fieldsetDisabled,
    set: (name, value) => this.write(name as string, value),
    emit: (name, detail, options) => this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true, cancelable: options?.cancelable ?? false })),
   };
   this.root.render(<Component {...context} />);
  }
 }

 for (const prop of Object.keys(specs)) Object.defineProperty(ResolveElement.prototype, prop, {
  configurable: true, enumerable: true,
  get(this: ResolveElement) { return (this as unknown as { values: Record<string, unknown> }).values[prop]; },
  set(this: ResolveElement, value: unknown) { this.write(prop, value); },
 });

 customElements.define(definition.tag, ResolveElement);
 return ResolveElement;
}

/** Shared helper: show validation only after interaction or a submit attempt, and focus the first invalid control. */
export function handleInvalid(host: HTMLElement, internals: ElementInternals | undefined, onShow: () => void) {
 const listener = (event: Event) => {
  event.preventDefault(); // replace the browser bubble with the element's own associated error text
  onShow();
  const form = internals?.form;
  if (!form || form.querySelector(':invalid:not(fieldset)') === host) host.focus();
 };
 host.addEventListener('invalid', listener);
 return () => host.removeEventListener('invalid', listener);
}
