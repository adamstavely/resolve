import { createApplication } from '@angular/platform-browser';
import { createCustomElement } from '@angular/elements';
import { registerElements } from '../../../packages/elements/src/index';
import { ConsoleComponent } from './app/console.component';

registerElements();
createApplication().then(app => customElements.define('resolve-console', createCustomElement(ConsoleComponent, { injector: app.injector })));
