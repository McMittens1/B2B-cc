import { useEffect, useSyncExternalStore } from 'react';

/**
 * Hash routing (#/p/<id>/payrolls) so the built app works from any static host or a
 * file share without server rewrites.
 */

function currentPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : '/';
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const target = `#${path}`;
  if (opts.replace) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (window.location.hash !== target) {
    window.location.hash = path;
  }
}

export type Route =
  | { name: 'projects' }
  | { name: 'new-project' }
  | { name: 'project'; projectId: string; section: ProjectSection; itemId: string | null }
  | { name: 'not-found' };

export type ProjectSection =
  | 'overview'
  | 'payrolls'
  | 'import'
  | 'exceptions'
  | 'restitution'
  | 'contractors'
  | 'wd'
  | 'documents'
  | 'settings';

const SECTIONS: ProjectSection[] = ['overview', 'payrolls', 'import', 'exceptions', 'restitution', 'contractors', 'wd', 'documents', 'settings'];

export function parseRoute(path: string): Route {
  let parts: string[];
  try {
    parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { name: 'not-found' }; // malformed percent-encoding in a hand-edited or truncated link
  }
  if (parts.length === 0) return { name: 'projects' };
  if (parts[0] === 'new') return { name: 'new-project' };
  if (parts[0] === 'p' && parts[1]) {
    const section = (parts[2] ?? 'overview') as ProjectSection;
    if (!SECTIONS.includes(section)) return { name: 'not-found' };
    return { name: 'project', projectId: parts[1], section, itemId: parts[3] ?? null };
  }
  return { name: 'not-found' };
}

export function projectPath(projectId: string, section: ProjectSection = 'overview', itemId?: string): string {
  return `/p/${encodeURIComponent(projectId)}/${section}${itemId ? `/${encodeURIComponent(itemId)}` : ''}`;
}

/** Update the document title for the current screen. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Wagebench` : 'Wagebench';
  }, [title]);
}
