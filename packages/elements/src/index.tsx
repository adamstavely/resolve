import { defineCombobox, type ComboboxEvents, type ComboboxProps } from './elements/combobox';
import { defineConfirmDialog, type ConfirmDialogEvents, type ConfirmDialogProps } from './elements/confirm-dialog';
import { defineTextField, type TextFieldEvents, type TextFieldProps } from './elements/text-field';

export type { ComboboxEvents, ComboboxOption, ComboboxProps } from './elements/combobox';
export type { ConfirmDialogEvents, ConfirmDialogProps } from './elements/confirm-dialog';
export type { TextFieldEvents, TextFieldProps } from './elements/text-field';

/** Form-associated element surface shared by Resolve input elements. */
interface FormElement {
 readonly form: HTMLFormElement | null;
 readonly name: string;
 readonly validity: ValidityState | undefined;
 readonly validationMessage: string;
 checkValidity(): boolean;
 reportValidity(): boolean;
}
export type ResolveTextFieldElement = HTMLElement & TextFieldProps & FormElement;
export type ResolveComboboxElement = HTMLElement & ComboboxProps & FormElement;
export type ResolveConfirmDialogElement = HTMLElement & ConfirmDialogProps;

/** Event detail maps, keyed by tag, for typed adapters. */
export interface ResolveElementEvents {
 'resolve-text-field': TextFieldEvents;
 'resolve-combobox': ComboboxEvents;
 'resolve-confirm-dialog': ConfirmDialogEvents;
}

declare global {
 interface HTMLElementTagNameMap {
  'resolve-text-field': ResolveTextFieldElement;
  'resolve-combobox': ResolveComboboxElement;
  'resolve-confirm-dialog': ResolveConfirmDialogElement;
 }
}

/** Registers every Resolve element once. All elements share one React runtime from this bundle. */
export function registerElements() {
 defineTextField();
 defineCombobox();
 defineConfirmDialog();
}
