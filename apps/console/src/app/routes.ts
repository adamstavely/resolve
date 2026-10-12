import type { Routes } from '@angular/router';
import { AuditPage } from './pages/audit.page';
import { ComponentsPage } from './pages/components.page';
import { HomePage } from './pages/home.page';
import { InboxPage } from './pages/inbox.page';
import { TicketDetailPage } from './pages/ticket-detail.page';
import { TicketsPage } from './pages/tickets.page';

export const routes: Routes = [
 { path: '', component: HomePage, title: 'Resolve' },
 { path: 'inbox', component: InboxPage, title: 'Inbox · Resolve' },
 { path: 'inbox/:app/:id', component: InboxPage, title: 'Inbox · Resolve' },
 // The conversations list and page were merged into the inbox.
 { path: 'conversations', redirectTo: 'inbox' },
 { path: 'conversations/:app/:id', redirectTo: 'inbox/:app/:id' },
 { path: 'tickets', component: TicketsPage, title: 'Tickets · Resolve' },
 { path: 'tickets/:app/:id', component: TicketDetailPage, title: 'Ticket · Resolve' },
 { path: 'audit', component: AuditPage, title: 'Audit · Resolve' },
 // Development page for the component bridge; reachable directly, not in navigation.
 { path: 'components', component: ComponentsPage, title: 'Component check · Resolve' },
 { path: '**', redirectTo: '' },
];
