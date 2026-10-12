import React, { useLayoutEffect, useRef } from 'react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { defineElement, type ElementContext } from '../core/define';

export interface ConfirmDialogProps {
 open: boolean;
 heading: string;
 description: string;
 confirmLabel: string;
 cancelLabel: string;
 tone: 'default' | 'destructive';
 /** The owner is completing the action; controls stay visible but cannot be activated twice. */
 pending: boolean;
}
export interface ConfirmDialogEvents {
 /** Cancelable: call preventDefault() to keep the dialog open (for example while pending). */
 confirm: Record<string, never>;
 cancel: Record<string, never>;
}

/**
 * Confirmation for destructive or bulk work (plan 00 phase 3). Opened by setting `open`; focus returns
 * to the element that was focused when it opened. Destructive confirmations focus Cancel first.
 */
function ConfirmDialog({ props: p, set, emit }: ElementContext<ConfirmDialogProps, ConfirmDialogEvents>) {
 const cancelRef = useRef<HTMLButtonElement>(null); const confirmRef = useRef<HTMLButtonElement>(null);
 // Radix restores focus only to its own Trigger. This dialog is opened by property, so remember the
 // invoking element (layout effects run before Radix moves focus) and restore it on close.
 const returnTo = useRef<HTMLElement | null>(null);
 useLayoutEffect(() => { if (p.open) returnTo.current = document.activeElement as HTMLElement | null; }, [p.open]);
 const close = () => { if (p.pending) return; set('open', false); emit('cancel', {}); };
 return <Dialog open={p.open} onOpenChange={next => { if (!next) close(); }}>
  <DialogContent role={p.tone === 'destructive' ? 'alertdialog' : 'dialog'}
   onOpenAutoFocus={e => { e.preventDefault(); (p.tone === 'destructive' ? cancelRef : confirmRef).current?.focus(); }}
   onCloseAutoFocus={e => { e.preventDefault(); if (returnTo.current?.isConnected) returnTo.current.focus(); }}>
   <DialogHeader><DialogTitle>{p.heading}</DialogTitle><DialogDescription>{p.description}</DialogDescription></DialogHeader>
   <DialogFooter className="gap-2">
    <Button ref={cancelRef} variant="outline" onClick={close} aria-disabled={p.pending || undefined}>{p.cancelLabel}</Button>
    <Button ref={confirmRef} variant={p.tone === 'destructive' ? 'destructive' : 'default'} aria-disabled={p.pending || undefined}
     onClick={() => { if (p.pending) return; if (emit('confirm', {}, { cancelable: true })) set('open', false); }}>
     {p.pending ? 'Working…' : p.confirmLabel}
    </Button>
   </DialogFooter>
   {p.pending && <p role="status" className="sr-only">Working…</p>}
  </DialogContent>
 </Dialog>;
}

export function defineConfirmDialog() {
 return defineElement<ConfirmDialogProps, ConfirmDialogEvents>({
  tag: 'resolve-confirm-dialog', component: ConfirmDialog,
  props: {
   open: { type: 'boolean', default: false }, heading: { type: 'string', default: '' }, description: { type: 'string', default: '' },
   confirmLabel: { type: 'string', default: 'Confirm' }, cancelLabel: { type: 'string', default: 'Cancel' },
   tone: { type: 'string', default: 'default' }, pending: { type: 'boolean', default: false },
  },
 });
}
