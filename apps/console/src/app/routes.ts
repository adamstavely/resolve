import type { Routes } from '@angular/router';
import { AppPage } from './pages/app.page';
import { AuditPage } from './pages/audit.page';
import { EvidencePage } from './pages/evidence.page';
import { ReceiptPage } from './pages/receipt.page';
import { AppAdminPage } from './pages/app-admin.page';
import { BroadcastPage } from './pages/broadcast.page';
import { BroadcastsPage } from './pages/broadcasts.page';
import { ApplicationsPage } from './pages/applications.page';
import { OnboardingPage } from './pages/onboarding.page';
import { PeoplePage } from './pages/people.page';
import { PilotPage } from './pages/pilot.page';
import { ComponentsPage } from './pages/components.page';
import { HomePage } from './pages/home.page';
import { IntegrationsPage } from './pages/integrations.page';
import { MappingPage } from './pages/mapping.page';
import { CasePage } from './pages/case.page';
import { InboxPage } from './pages/inbox.page';
import { EscalationsPage } from './pages/escalations.page';
import { MyTicketsPage } from './pages/my-tickets.page';

export const routes: Routes = [
 { path: '', component: HomePage, title: 'Resolve' },
 // Inbox lists chats and My tickets lists tickets (plan 16); both open in the case workspace.
 { path: 'inbox', component: InboxPage, title: 'Inbox · Resolve' },
 { path: 'inbox/:app/:id', component: CasePage, data: { kind: 'conversation' }, title: 'Chat · Resolve' },
 { path: 'tickets', component: MyTicketsPage, title: 'My tickets · Resolve' },
 { path: 'tickets/:app/:id', component: CasePage, data: { kind: 'ticket' }, title: 'Ticket · Resolve' },
 // The conversations list and page were merged into the inbox.
 { path: 'conversations', redirectTo: 'inbox', pathMatch: 'full' },
 { path: 'conversations/:app/:id', redirectTo: 'inbox/:app/:id' },
 { path: 'apps/:appKey', component: AppPage, title: 'Application · Resolve' },
 { path: 'evidence/:id', component: EvidencePage, title: 'Evidence snapshot · Resolve' },
 { path: 'receipts/:operationId', component: ReceiptPage, title: 'Receipt · Resolve' },
 { path: 'escalations', component: EscalationsPage, title: 'Escalations · Resolve' },
 { path: 'audit', component: AuditPage, title: 'Audit · Resolve' },
 { path: 'applications', component: ApplicationsPage, title: 'Applications · Resolve' },
 { path: 'applications/onboarding/new', component: OnboardingPage, title: 'Register an application · Resolve' },
 { path: 'applications/onboarding/:runId', component: OnboardingPage, title: 'Onboarding · Resolve' },
 { path: 'applications/:appKey', component: AppAdminPage, title: 'Application · Resolve' },
 { path: 'integrations', component: IntegrationsPage, title: 'Integrations · Resolve' },
 { path: 'integrations/apps/:appKey', component: MappingPage, title: 'Elastic mapping · Resolve' },
 { path: 'people', component: PeoplePage, title: 'People and roles · Resolve' },
 { path: 'announcements', component: BroadcastsPage, title: 'Announcements · Resolve' },
 { path: 'announcements/new', component: BroadcastPage, title: 'New banner · Resolve' },
 { path: 'announcements/:id', component: BroadcastPage, title: 'Banner · Resolve' },
 { path: 'onboarding/:runId/pilot', component: PilotPage, title: 'Pilot check · Resolve' },
 // Development page for the component bridge; reachable directly, not in navigation.
 { path: 'components', component: ComponentsPage, title: 'Component check · Resolve' },
 { path: '**', redirectTo: '' },
];
