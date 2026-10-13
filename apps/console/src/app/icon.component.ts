import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Interop icon set: 24px grid, 1.6px stroke, round joins, currentColor (design/reference/interop-style-guide.html §05). */
const ICONS = {
 search: 'M11 19a8 8 0 1 1 5.29-2.01l4.36 4.36M11 19a8 8 0 0 0 5.29-2.01',
 command: 'M9 9V7a2 2 0 1 0-2 2h2Zm0 0v6m0-6h6M9 15v2a2 2 0 1 1-2-2h2Zm6 0v2a2 2 0 1 0 2-2h-2Zm0 0V9m0 6H9m6-6V7a2 2 0 1 1 2 2h-2Z',
 sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
 moon: 'M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z',
 lock: 'M7 11V8a5 5 0 0 1 10 0v3m-12 0h14v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9Z',
 shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z',
 shieldCheck: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4',
 check: 'M5 12.5 10 17.5 19 7',
 chevR: 'M9 5l7 7-7 7',
 chevD: 'M5 9l7 7 7-7',
 arrowUp: 'M12 19V5m0 0-6 6m6-6 6 6',
 arrowR: 'M5 12h14m0 0-6-6m6 6-6 6',
 x: 'M6 6l12 12M18 6 6 18',
 grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
 bolt: 'M13 3 4 14h7l-1 7 9-11h-7l1-7Z',
 refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16m0 5v-5h5',
 dollar: 'M12 3v18M16 7.5C16 5.6 14.2 4 12 4S8 5.6 8 7.5 9.8 11 12 11s4 1.6 4 3.5S14.2 18 12 18s-4-1.6-4-3.5',
 alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
 user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6 8a6 6 0 0 0-12 0',
 users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 8a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M21 19a6 6 0 0 0-4-5.6',
 clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3.5 2',
 plus: 'M12 5v14M5 12h14',
 minus: 'M5 12h14',
 key: 'M14 9a4 4 0 1 0-3.5 3.96L11 14l2 2-1 2 2 2 3-3-5.5-5.5A4 4 0 0 0 14 9Z',
 snow: 'M12 2v20M4.5 6 19.5 18M19.5 6 4.5 18M2 12h20M7 4l5 3 5-3M7 20l5-3 5 3',
 doc: 'M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z',
 swap: 'M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8',
 ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
 filter: 'M3 5h18l-7 8v6l-4-2v-4L3 5Z',
 dot: 'M12 12h.01',
 pin: 'M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
 activity: 'M3 12h4l3 8 4-16 3 8h4',
 bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
 logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
 sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5M14 4v4M6 10v4M11 16v4',
 arrowL: 'M19 12H5m0 0 6-6m-6 6 6 6',
 send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
 layers: 'M12 2 2 7l10 5 10-5-10-5Zm10 10-10 5L2 12m20 5-10 5L2 17',
 chat: 'M4 5h16v11H9l-5 4V5Z',
 mail: 'M3 6h18v12H3V6Zm0 0 9 7 9-7',
 link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
 book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm0 13a3 3 0 0 1 3-3h11',
 branch: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
 globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
 inbox: 'M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6l2-8Z',
 copy: 'M9 9h11v11H9V9ZM15 9V4H4v11h5',
 sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
 close: 'M6 6l12 12M18 6 6 18',
 help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.5-11.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14m0 3v.01',
 pulse: 'M3 12h4l3 8 4-16 3 8h4',
 megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Zm12-3a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14',
 ticket: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5V7Zm10-2v14',
 paperclip: 'M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15 8',
 selector: 'rs-mark',
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
