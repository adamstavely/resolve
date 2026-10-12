import { Directive, ElementRef, effect, inject, input, model, output } from '@angular/core';
import type {
 ComboboxEvents, ComboboxOption, TextFieldEvents, ResolveComboboxElement, ResolveConfirmDialogElement, ResolveTextFieldElement,
} from '../../../../packages/elements/src/index';

/*
 * Typed Angular adapters for Resolve custom elements. Each directive matches the element tag, so
 * strictTemplates type-checks bindings, and forwards inputs to element properties (never attributes).
 * `value` and `open` are models: [(value)] and [(open)] stay in sync with user changes.
 * Templates still need CUSTOM_ELEMENTS_SCHEMA because a directive does not declare an element.
 */

function bind<T extends HTMLElement>(el: T, read: () => Partial<T>) {
 effect(() => Object.assign(el, read()));
}

@Directive({ selector: 'resolve-text-field', host: { '(value-change)': 'onValueChange($event)' } })
export class ResolveTextField {
 readonly element = inject<ElementRef<ResolveTextFieldElement>>(ElementRef).nativeElement;
 readonly label = input.required<string>();
 readonly value = model('');
 readonly hint = input('');
 readonly error = input('');
 readonly required = input(false);
 readonly disabled = input(false);
 readonly maxlength = input(0);
 readonly kind = input<'text' | 'email' | 'url'>('text');
 readonly autocomplete = input('');
 constructor() {
  bind(this.element, () => ({ label: this.label(), value: this.value(), hint: this.hint(), error: this.error(), required: this.required(),
   disabled: this.disabled(), maxlength: this.maxlength(), kind: this.kind(), autocomplete: this.autocomplete() }));
 }
 onValueChange(event: Event) { this.value.set((event as CustomEvent<TextFieldEvents['value-change']>).detail.value); }
}

@Directive({ selector: 'resolve-combobox', host: { '(value-change)': 'onValueChange($event)' } })
export class ResolveCombobox {
 readonly element = inject<ElementRef<ResolveComboboxElement>>(ElementRef).nativeElement;
 readonly label = input.required<string>();
 readonly value = model('');
 readonly options = input.required<ComboboxOption[]>();
 readonly placeholder = input('Select…');
 readonly searchLabel = input('Search options');
 readonly emptyText = input('No matching option.');
 readonly hint = input('');
 readonly required = input(false);
 readonly disabled = input(false);
 constructor() {
  bind(this.element, () => ({ label: this.label(), value: this.value(), options: this.options(), placeholder: this.placeholder(),
   searchLabel: this.searchLabel(), emptyText: this.emptyText(), hint: this.hint(), required: this.required(), disabled: this.disabled() }));
 }
 onValueChange(event: Event) { this.value.set((event as CustomEvent<ComboboxEvents['value-change']>).detail.value); }
}

@Directive({
 selector: 'resolve-confirm-dialog',
 host: { '(confirm)': 'onConfirm($event)', '(cancel)': 'open.set(false); cancelled.emit()' },
})
export class ResolveConfirmDialog {
 readonly element = inject<ElementRef<ResolveConfirmDialogElement>>(ElementRef).nativeElement;
 readonly open = model(false);
 readonly heading = input.required<string>();
 readonly description = input.required<string>();
 readonly confirmLabel = input('Confirm');
 readonly cancelLabel = input('Cancel');
 readonly tone = input<'default' | 'destructive'>('default');
 readonly pending = input(false);
 /** Emits the cancelable DOM event; call preventDefault() to keep the dialog open. */
 readonly confirmed = output<Event>();
 readonly cancelled = output<void>();
 constructor() {
  bind(this.element, () => ({ open: this.open(), heading: this.heading(), description: this.description(), confirmLabel: this.confirmLabel(),
   cancelLabel: this.cancelLabel(), tone: this.tone(), pending: this.pending() }));
 }
 onConfirm(event: Event) {
  this.confirmed.emit(event);
  if (!event.defaultPrevented) this.open.set(false);
 }
}

export const RESOLVE_ELEMENTS = [ResolveTextField, ResolveCombobox, ResolveConfirmDialog] as const;
