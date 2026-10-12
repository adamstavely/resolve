import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { defineElement, handleInvalid, type ElementContext } from '../core/define';

export interface TextFieldProps {
 label: string;
 value: string;
 hint: string;
 /** Server or cross-field error supplied by the owner; shown immediately and blocks submission. */
 error: string;
 required: boolean;
 disabled: boolean;
 maxlength: number;
 /** Validated by the element. The inner control stays type="text" so it never joins form validation itself. */
 kind: 'text' | 'email' | 'url';
 autocomplete: string;
}
export interface TextFieldEvents { 'value-change': { value: string } }

function message(p: TextFieldProps): string {
 const value = p.value.trim();
 if (p.error) return p.error;
 if (p.required && !value) return `Enter ${p.label.toLowerCase()}.`;
 if (value && p.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter an email address in the format name@example.com.';
 if (value && p.kind === 'url' && !URL.canParse(value)) return 'Enter a full URL, starting with https://.';
 return '';
}

function TextField({ host, props: p, disabled, set, emit, internals }: ElementContext<TextFieldProps, TextFieldEvents>) {
 const id = useId(); const input = useRef<HTMLInputElement>(null);
 const [touched, setTouched] = useState(false); const dirty = useRef(false);
 const error = message(p);
 const show = !!error && (touched || !!p.error);

 useLayoutEffect(() => {
  internals?.setFormValue(disabled ? null : p.value);
  if (error) internals?.setValidity(p.error ? { customError: true } : p.required && !p.value.trim() ? { valueMissing: true } : { typeMismatch: true }, error, input.current ?? undefined);
  else internals?.setValidity({});
 }, [internals, p.value, error, disabled, p.error, p.required]);
 useEffect(() => handleInvalid(host, internals, () => setTouched(true)), [host, internals]);
 useEffect(() => {
  const form = internals?.form; const reset = () => { setTouched(false); dirty.current = false; };
  form?.addEventListener('reset', reset); return () => form?.removeEventListener('reset', reset);
 }, [internals?.form]);

 const describedBy = [p.hint && id + 'hint', show && id + 'error'].filter(Boolean).join(' ') || undefined;
 return <div className="grid gap-1.5">
  <Label htmlFor={id + 'input'}>{p.label}{p.required && <span className="text-muted-foreground font-normal"> (required)</span>}</Label>
  {p.hint && <p id={id + 'hint'} className="text-sm text-muted-foreground m-0">{p.hint}</p>}
  <Input ref={input} id={id + 'input'} data-element-focus="" type="text"
   inputMode={p.kind === 'email' ? 'email' : p.kind === 'url' ? 'url' : undefined}
   autoComplete={p.autocomplete || undefined} spellCheck={p.kind === 'text' ? undefined : false}
   value={p.value} maxLength={p.maxlength > 0 ? p.maxlength : undefined} disabled={disabled}
   aria-required={p.required || undefined} aria-invalid={show || undefined} aria-describedby={describedBy}
   className={show ? 'border-destructive' : undefined}
   onChange={e => { dirty.current = true; set('value', e.target.value); emit('value-change', { value: e.target.value }); }}
   onBlur={() => { if (dirty.current) setTouched(true); }} />
  {show && <p id={id + 'error'} className="text-sm text-destructive font-medium m-0"><span className="sr-only">Error: </span>{error}</p>}
 </div>;
}

export function defineTextField() {
 return defineElement<TextFieldProps, TextFieldEvents>({
  tag: 'resolve-text-field', formAssociated: true, component: TextField,
  props: {
   label: { type: 'string', default: '' }, value: { type: 'string', default: '' }, hint: { type: 'string', default: '' },
   error: { type: 'string', default: '' }, required: { type: 'boolean', default: false }, disabled: { type: 'boolean', default: false, reflect: true },
   maxlength: { type: 'number', default: 0 }, kind: { type: 'string', default: 'text' }, autocomplete: { type: 'string', default: '' },
  },
 });
}
