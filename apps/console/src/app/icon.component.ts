import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Interop icon set: 24px grid, 1.6px stroke, round joins, currentColor (design/reference/interop-style-guide.html §05). */
const ICONS = {
 grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
 sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
 moon: 'M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z',
 logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
 shieldCheck: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4',
 activity: 'M3 12h4l3 8 4-16 3 8h4',
 doc: 'M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z',
 user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6 8a6 6 0 0 0-12 0',
 sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5M14 4v4M6 10v4M11 16v4',
 refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16m0 5v-5h5',
 lock: 'M7 11V8a5 5 0 0 1 10 0v3m-12 0h14v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9Z',
 check: 'M5 12.5 10 17.5 19 7',
 alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
} as const;
export type IconName = keyof typeof ICONS;

@Component({
 selector: 'rs-icon',
 changeDetection: ChangeDetectionStrategy.OnPush,
 host: { style: 'display:inline-flex;flex:none' },
 template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  @for (d of paths(); track $index) { <path [attr.d]="d" /> }</svg>`,
})
export class IconComponent {
 readonly name = input.required<IconName>();
 readonly size = input(16);
 readonly paths = computed(() => ICONS[this.name()].split('M').filter(Boolean).map(s => 'M' + s));
}

/** The Resolve lifebuoy mark (design/reference/resolve-console.html). */
@Component({
 selector: 'rs-mark',
 changeDetection: ChangeDetectionStrategy.OnPush,
 host: { style: 'display:contents' },
 template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
  @if (variant() === 'hero') {
   <circle cx="32" cy="32" r="22" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="4.2" />
   <circle cx="32" cy="32" r="9" fill="var(--surface)" stroke="var(--accent)" stroke-width="4.2" />
  } @else {
   <circle cx="32" cy="32" r="22" stroke="currentColor" stroke-width="4.2" />
   <circle cx="32" cy="32" r="9" stroke="currentColor" stroke-width="4.2" />
  }
  @for (l of spokes; track $index) {
   <line [attr.x1]="l[0]" [attr.y1]="l[1]" [attr.x2]="l[2]" [attr.y2]="l[3]" [attr.stroke]="variant() === 'hero' ? 'var(--accent-strong)' : 'currentColor'" stroke-width="5" stroke-linecap="round" />
  }</svg>`,
})
export class MarkComponent {
 readonly size = input<number | string>(18);
 readonly variant = input<'tile' | 'hero'>('tile');
 readonly spokes = [[32, 12, 32, 22], [32, 52, 32, 42], [12, 32, 22, 32], [52, 32, 42, 32]];
}
