import '@angular/compiler';
import { Component, CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { createCustomElement } from '@angular/elements';
import { registerElements } from '../../../packages/elements/src/index';
import { healthSchema } from '../../../packages/contracts/src/index';
@Component({selector:'resolve-root',standalone:true,schemas:[CUSTOM_ELEMENTS_SCHEMA],template:`
<a class="skip" href="#main">Skip to main content</a><div class="shell"><header><div class="brand">resolve<span class="badge"> / foundation</span></div><button type="button" (click)="toggleTheme()" [attr.aria-pressed]="dark()">Dark appearance</button></header>
<main id="main" tabindex="-1"><section class="hero"><p class="badge">Phase 1 · Development workspace</p><h1>One place to support<br>every application.</h1><p class="muted">The foundation for Resolve’s fleet console. Validate the component and service boundaries before connecting applications.</p></section>
<section class="panel" aria-labelledby="service-title"><h2 id="service-title">Service connection</h2><p role="status">{{ health() }}</p><p class="muted">Authentication, tenant connections and fleet operations are not available in this foundation build.</p></section>
<resolve-lab (preference-change)="onPreference($event)"/><p class="muted" role="status">{{ eventStatus() }}</p></main></div>`})
class ConsoleComponent {
 dark=signal(false);health=signal('Checking backend…');eventStatus=signal('Angular is ready to receive component events.');
 constructor(){fetch('/api/health').then(async r=>{if(!r.ok)throw Error();healthSchema.parse(await r.json());this.health.set('Resolve API is reachable · contract v1');}).catch(()=>this.health.set('Backend unavailable. Start the API service and reload.'));}
 toggleTheme(){this.dark.update(v=>!v);document.documentElement.dataset['theme']=this.dark()?'dark':'light';}
 onPreference(event:Event){const detail=(event as CustomEvent<{name:string}>).detail;this.eventStatus.set('Angular received the local preference for '+detail.name+'.');}
}
registerElements();
createApplication().then(app=>customElements.define('resolve-console',createCustomElement(ConsoleComponent,{injector:app.injector})));
