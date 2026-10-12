import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../components/ui/command';
import { Label } from '../components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { cn } from '../lib/utils';
import { defineElement, handleInvalid, type ElementContext } from '../core/define';

export interface ComboboxOption { value: string; label: string }
export interface ComboboxProps {
 label: string;
 value: string;
 options: ComboboxOption[];
 placeholder: string;
 searchLabel: string;
 emptyText: string;
 hint: string;
 required: boolean;
 disabled: boolean;
}
export interface ComboboxEvents { 'value-change': { value: string } }

/** shadcn "Combobox" pattern (Popover + Command) exposed as a form-associated element. */
function Combobox({ host, props: p, disabled, set, emit, internals }: ElementContext<ComboboxProps, ComboboxEvents>) {
 const id = useId(); const trigger = useRef<HTMLButtonElement>(null);
 const [open, setOpen] = useState(false); const [touched, setTouched] = useState(false);
 const selected = p.options.find(o => o.value === p.value);
 const error = p.required && !selected ? `Choose ${p.label.toLowerCase()}.` : '';
 const show = !!error && touched;

 useLayoutEffect(() => {
  internals?.setFormValue(disabled || !selected ? null : selected.value);
  if (error) internals?.setValidity({ valueMissing: true }, error, trigger.current ?? undefined); else internals?.setValidity({});
 }, [internals, selected, error, disabled]);
 useEffect(() => handleInvalid(host, internals, () => setTouched(true)), [host, internals]);
 useEffect(() => {
  const form = internals?.form; const reset = () => setTouched(false);
  form?.addEventListener('reset', reset); return () => form?.removeEventListener('reset', reset);
 }, [internals?.form]);

 const describedBy = [p.hint && id + 'hint', show && id + 'error'].filter(Boolean).join(' ') || undefined;
 return <div className="grid gap-1.5">
  <Label id={id + 'label'}>{p.label}{p.required && <span className="text-muted-foreground font-normal"> (required)</span>}</Label>
  {p.hint && <p id={id + 'hint'} className="text-sm text-muted-foreground m-0">{p.hint}</p>}
  <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setTouched(t => t || !!p.required); }}>
   <PopoverTrigger asChild>
    <Button ref={trigger} id={id + 'trigger'} data-element-focus="" variant="outline" role="combobox" disabled={disabled}
     aria-labelledby={`${id}label ${id}trigger`} aria-expanded={open} aria-required={p.required || undefined}
     aria-invalid={show || undefined} aria-describedby={describedBy}
     className={cn('w-full justify-between font-normal', show && 'border-destructive', !selected && 'text-muted-foreground')}>
     {selected?.label ?? p.placeholder}<ChevronsUpDown aria-hidden="true" />
    </Button>
   </PopoverTrigger>
   <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0" align="start">
    <Command>
     <CommandInput placeholder={p.searchLabel} aria-label={p.searchLabel} />
     <CommandList>
      <CommandEmpty>{p.emptyText}</CommandEmpty>
      {p.options.map(o => <CommandItem key={o.value} value={o.label} onSelect={() => {
       set('value', o.value); emit('value-change', { value: o.value }); setTouched(true); setOpen(false);
      }}>
       <Check aria-hidden="true" className={cn(o.value === p.value ? 'opacity-100' : 'opacity-0')} />{o.label}
      </CommandItem>)}
     </CommandList>
    </Command>
   </PopoverContent>
  </Popover>
  {show && <p id={id + 'error'} className="text-sm text-destructive font-medium m-0"><span className="sr-only">Error: </span>{error}</p>}
 </div>;
}

export function defineCombobox() {
 return defineElement<ComboboxProps, ComboboxEvents>({
  tag: 'resolve-combobox', formAssociated: true, component: Combobox,
  props: {
   label: { type: 'string', default: '' }, value: { type: 'string', default: '' },
   options: { type: 'json', default: [] }, placeholder: { type: 'string', default: 'Select…' },
   searchLabel: { type: 'string', default: 'Search options' }, emptyText: { type: 'string', default: 'No matching option.' },
   hint: { type: 'string', default: '' }, required: { type: 'boolean', default: false }, disabled: { type: 'boolean', default: false, reflect: true },
  },
 });
}
