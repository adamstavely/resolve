import { createApplication } from '@angular/platform-browser';
import { createCustomElement } from '@angular/elements';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { registerElements } from '../../../packages/elements/src/index';
import { routes } from './app/routes';
import { ShellComponent } from './app/shell.component';

registerElements();
createApplication({ providers: [provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ anchorScrolling: 'enabled', scrollPositionRestoration: 'top' }))] })
 .then(app => customElements.define('resolve-console', createCustomElement(ShellComponent, { injector: app.injector })));
