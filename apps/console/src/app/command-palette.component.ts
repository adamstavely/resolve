import { Component, computed, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { IconComponent, type IconName } from './icon.component';
import { AppState } from './state';
import { WorkService } from './work.service';

interface Item { group: string; icon: IconName; label: string; meta: string; route: unknown[] }

/**
 * Command palette (prototype `CommandPalette`, ⌘K): jump to an application, one of your tickets or chats, or a page.
 * A combobox with an owned listbox; arrow keys move, Enter opens, Escape closes. Account search and tools appear
 * here once account tools are connected.
 */
@Component({
 selector: 'rs-command-palette',
 imports: [IconComponent],
 template: `
<div class="cmd-scrim" (click)="closed.emit()">
 <div class="cmd-modal" role="dialog" aria-modal="true" aria-label="Search Resolve" (click)="$event.stopPropagation()">
  <div class="cmd-input-row">
   <rs-icon name="search" [size]="20" style="color:var(--ink-3)" />
   <input #q role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-autocomplete="list" aria-label="Search apps, tickets and pages"
    [attr.aria-activedescendant]="matched().length ? 'cmd-' + active() : null" [value]="query()" (input)="query.set($any($event.target).value); active.set(0)"
    (keydown)="onKey($event)" placeholder="Search apps, tickets, pages…" />
   <span class="kbd">esc</span>
  </div>
  <div class="cmd-list" id="cmd-list" role="listbox" aria-label="Results">
   @for (g of groups(); track g) {
    <div role="group" [attr.aria-labelledby]="'cmd-g-' + $index">
     <div class="cmd-group-label" [id]="'cmd-g-' + $index">{{ g }}</div>
     @for (i of inGroup(g); track i.idx) {
      <div class="cmd-item" role="option" [id]="'cmd-' + i.idx" [attr.aria-selected]="i.idx === active()" [attr.data-active]="i.idx === active()"
       (mouseenter)="active.set(i.idx)" (click)="run(i.item)">
       <span class="ci"><rs-icon [name]="i.item.icon" [size]="16" /></span>
       <span class="ct">{{ i.item.label }}</span>
       <span class="cm">{{ i.item.meta }}</span>
      </div>
     }
    </div>
   }
   @if (!matched().length) { <div class="cmd-group-label" style="padding:24px;text-align:center">No matches</div> }
  </div>
  <div class="cmd-foot">
   <span><span class="kbd">↑↓</span> navigate</span>
   <span><span class="kbd">↵</span> open</span>
   <span><span class="kbd">esc</span> close</span>
  </div>
 </div>
</div>`,
})
export class CommandPaletteComponent {
 readonly closed = output<void>();
 private readonly state = inject(AppState);
 private readonly work = inject(WorkService);
 private readonly router = inject(Router);
 readonly query = signal('');
 readonly active = signal(0);
 private readonly input = viewChild<ElementRef<HTMLInputElement>>('q');

 private readonly items = computed<Item[]>(() => {
  const apps = (this.state.apps()?.apps ?? []).map(a => ({ group: 'Applications', icon: 'grid' as IconName, label: a.displayName, meta: a.description || a.appKey, route: ['/apps', a.appKey] }));
  const work = [...this.work.items(), ...this.work.chats()].map(w => ({ group: w.kind === 'ticket' ? 'Tickets' : 'Chats', icon: (w.channel === 'chat' ? 'chat' : 'mail') as IconName, label: w.subject,
   meta: `${this.state.appName(w.appKey)} · ${w.ref}`, route: [w.kind === 'ticket' ? '/tickets' : '/inbox', w.appKey, w.id] }));
  const pages: Item[] = [
   { group: 'Pages', icon: 'inbox', label: 'Inbox', meta: 'Chats', route: ['/inbox'] },
   { group: 'Pages', icon: 'ticket', label: 'My tickets', meta: 'Tickets', route: ['/tickets'] },
   { group: 'Pages', icon: 'arrowUp', label: 'Escalations', meta: 'Escalation queue', route: ['/escalations'] },
  ];
  if ((this.state.can('broadcast.publish') || this.state.can('broadcast.app'))) pages.push({ group: 'Pages', icon: 'megaphone', label: 'Announcements', meta: 'Banners', route: ['/announcements'] });
  if (this.state.can('app.register')) pages.push({ group: 'Pages', icon: 'grid', label: 'Applications', meta: 'Administration', route: ['/applications'] });
  if (this.state.can('observability.configure')) pages.push({ group: 'Pages', icon: 'pulse', label: 'Integrations', meta: 'Administration', route: ['/integrations'] });
  if (this.state.can('audit.read')) pages.push({ group: 'Pages', icon: 'doc', label: 'Audit', meta: 'Administration', route: ['/audit'] });
  return [...apps, ...work, ...pages];
 });
 readonly matched = computed(() => {
  const q = this.query().trim().toLowerCase();
  return (q ? this.items().filter(i => (i.label + ' ' + i.meta).toLowerCase().includes(q)) : this.items().slice(0, 7)).slice(0, 40);
 });
 readonly groups = computed(() => [...new Set(this.matched().map(i => i.group))]);
 inGroup(g: string) { return this.matched().map((item, idx) => ({ item, idx })).filter(x => x.item.group === g); }

 ngAfterViewInit() { this.input()?.nativeElement.focus(); }
 onKey(e: KeyboardEvent) {
  const n = this.matched().length;
  if (e.key === 'ArrowDown') { e.preventDefault(); this.active.set(Math.min(this.active() + 1, n - 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); this.active.set(Math.max(this.active() - 1, 0)); }
  else if (e.key === 'Enter') { e.preventDefault(); const i = this.matched()[this.active()]; if (i) this.run(i); }
  else if (e.key === 'Escape') { e.preventDefault(); this.closed.emit(); }
 }
 run(i: Item) { this.closed.emit(); void this.router.navigate(i.route as string[]); }
}
