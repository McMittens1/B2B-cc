import { useEffect, type ReactNode } from 'react';
import { formatMoney } from '../engine/money';
import { navigate, parseRoute, projectPath, usePath, type ProjectSection } from './router';
import { projectStore, useProjectSnapshot, useProjectView } from './store';
import { BrandMark, Button, EmptyState, Icon, Spinner } from './ui';
import { ProjectsPage } from './pages/ProjectsPage';
import { NewProjectPage } from './pages/NewProjectPage';
import { OverviewPage } from './pages/OverviewPage';
import { PayrollsPage } from './pages/PayrollsPage';
import { PayrollReviewPage } from './pages/PayrollReviewPage';
import { ImportPage } from './pages/ImportPage';
import { ExceptionsPage } from './pages/ExceptionsPage';
import { RestitutionPage } from './pages/RestitutionPage';
import { ContractorsPage } from './pages/ContractorsPage';
import { WageDeterminationPage } from './pages/WageDeterminationPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const path = usePath();
  const route = parseRoute(path);
  const projectId = route.name === 'project' ? route.projectId : null;

  useEffect(() => {
    if (projectId) void projectStore.open(projectId);
    else projectStore.close();
  }, [projectId]);

  if (route.name === 'project') {
    return (
      <Shell projectSection={route.section}>
        <ProjectRoute section={route.section} itemId={route.itemId} />
      </Shell>
    );
  }
  return (
    <Shell>
      {route.name === 'projects' && <ProjectsPage />}
      {route.name === 'new-project' && <NewProjectPage />}
      {route.name === 'not-found' && (
        <div className="page">
          <EmptyState title="Page not found" actions={<Button onClick={() => navigate('/')}>Go to projects</Button>} />
        </div>
      )}
    </Shell>
  );
}

function ProjectRoute({ section, itemId }: { section: ProjectSection; itemId: string | null }) {
  const snap = useProjectSnapshot();
  const view = useProjectView();
  if (snap.status === 'loading' || snap.status === 'idle') return <Spinner />;
  if (snap.status === 'missing' || !view) {
    return (
      <div className="page">
        <EmptyState title="This project is not in this browser" actions={<Button onClick={() => navigate('/')}>Go to projects</Button>}>
          Projects are stored locally in the browser where they were created. Restore a backup to open it here.
        </EmptyState>
      </div>
    );
  }
  switch (section) {
    case 'overview':
      return <OverviewPage view={view} />;
    case 'payrolls':
      return itemId ? <PayrollReviewPage key={itemId} view={view} payrollId={itemId} /> : <PayrollsPage view={view} />;
    case 'import':
      return <ImportPage view={view} />;
    case 'exceptions':
      return <ExceptionsPage view={view} />;
    case 'restitution':
      return <RestitutionPage view={view} />;
    case 'contractors':
      return <ContractorsPage view={view} />;
    case 'wd':
      return <WageDeterminationPage view={view} />;
    case 'documents':
      return <DocumentsPage view={view} />;
    case 'settings':
      return <SettingsPage view={view} />;
  }
}

function Shell({ children, projectSection }: { children: ReactNode; projectSection?: ProjectSection }) {
  const view = useProjectView();
  const inProject = Boolean(projectSection);
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <BrandMark />
          Wagebench
        </a>
        {inProject && view && (
          <>
            <span className="sep" />
            <span className="project-name" title={view.data.project.name}>{view.data.project.name}</span>
          </>
        )}
        <span className="spacer" />
        <span className="privacy" title="Wagebench has no server. Payrolls, wage determinations and findings are stored only in this browser's local storage and never uploaded.">
          <Icon name="lock" />
          Local only — nothing is uploaded
        </span>
        {inProject && view && (
          <Button variant="primary" icon="import" onClick={() => navigate(projectPath(view.data.project.id, 'import'))}>
            Add payrolls
          </Button>
        )}
      </header>
      <div className={`body ${inProject ? '' : 'no-sidebar'}`}>
        {inProject && projectSection && <Sidebar section={projectSection} />}
        <main className="main" id="main">
          {inProject && projectSection && <MobileNav section={projectSection} />}
          {children}
        </main>
      </div>
    </div>
  );
}

interface NavEntry {
  section: ProjectSection;
  label: string;
  icon: string;
  count?: string;
  countTone?: 'bad';
}

function useNavEntries(): NavEntry[] {
  const view = useProjectView();
  const violations = view ? view.openFindings.filter((f) => f.severity === 'violation').length : 0;
  const unreviewed = view ? view.data.payrolls.filter((p) => p.status === 'received').length : 0;
  const outstanding = view?.ledger.totals.outstanding ?? 0;
  return [
    { section: 'overview', label: 'Overview', icon: 'overview' },
    { section: 'payrolls', label: 'Payrolls', icon: 'payroll', count: unreviewed ? `${unreviewed} to review` : undefined },
    { section: 'exceptions', label: 'Exceptions', icon: 'alert', count: violations ? String(violations) : undefined, countTone: 'bad' },
    { section: 'restitution', label: 'Restitution', icon: 'dollar', count: outstanding ? formatMoney(outstanding) : undefined, countTone: 'bad' },
    { section: 'documents', label: 'Letters & documents', icon: 'doc' },
    { section: 'contractors', label: 'Contractors', icon: 'users', count: view ? String(view.data.contractors.length) : undefined },
    { section: 'wd', label: 'Wage determination', icon: 'book', count: view && !view.data.wd ? '!' : undefined, countTone: 'bad' },
    { section: 'settings', label: 'Project settings', icon: 'settings' },
  ];
}

function Sidebar({ section }: { section: ProjectSection }) {
  const view = useProjectView();
  const entries = useNavEntries();
  if (!view) return <aside className="sidebar" />;
  const id = view.data.project.id;
  return (
    <aside className="sidebar" aria-label="Project navigation">
      <a className="nav-item" href="#/" style={{ marginBottom: 6 }}>
        <Icon name="back" />
        All projects
      </a>
      <div className="group-label">Review</div>
      {entries.slice(0, 5).map((e) => (
        <NavLink key={e.section} entry={e} active={section === e.section} href={`#${projectPath(id, e.section)}`} />
      ))}
      <div className="group-label">Setup</div>
      {entries.slice(5).map((e) => (
        <NavLink key={e.section} entry={e} active={section === e.section} href={`#${projectPath(id, e.section)}`} />
      ))}
    </aside>
  );
}

function NavLink({ entry, active, href }: { entry: NavEntry; active: boolean; href: string }) {
  return (
    <a className={`nav-item ${active ? 'active' : ''}`} href={href} aria-current={active ? 'page' : undefined}>
      <Icon name={entry.icon} />
      {entry.label}
      {entry.count && <span className={`count ${entry.countTone ?? ''}`}>{entry.count}</span>}
    </a>
  );
}

function MobileNav({ section }: { section: ProjectSection }) {
  const view = useProjectView();
  const entries = useNavEntries();
  if (!view) return null;
  return (
    <nav className="mobile-nav" aria-label="Project sections">
      {entries.map((e) => (
        <a key={e.section} className={`nav-item ${section === e.section ? 'active' : ''}`} href={`#${projectPath(view.data.project.id, e.section)}`}>
          {e.label}
        </a>
      ))}
    </nav>
  );
}
