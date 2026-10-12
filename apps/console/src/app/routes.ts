import type { Routes } from '@angular/router';
import { AuditPage } from './pages/audit.page';
import { ComponentsPage } from './pages/components.page';
import { ConversationDetailPage } from './pages/conversation-detail.page';
import { ConversationsPage } from './pages/conversations.page';
import { HomePage } from './pages/home.page';
import { InboxPage } from './pages/inbox.page';
import { TicketDetailPage } from './pages/ticket-detail.page';
import { TicketsPage } from './pages/tickets.page';

export const routes: Routes = [
 { path: '', component: HomePage, title: 'Resolve' },
 { path: 'inbox', component: InboxPage, title: 'Inbox · Resolve' },
 { path: 'tickets', component: TicketsPage, title: 'Tickets · Resolve' },
 { path: 'tickets/:app/:id', component: TicketDetailPage, title: 'Ticket · Resolve' },
 { path: 'conversations', component: ConversationsPage, title: 'Conversations · Resolve' },
 { path: 'conversations/:app/:id', component: ConversationDetailPage, title: 'Conversation · Resolve' },
 { path: 'audit', component: AuditPage, title: 'Audit · Resolve' },
 { path: 'components', component: ComponentsPage, title: 'Component check · Resolve' },
 { path: '**', redirectTo: '' },
];
