import { useState, type FormEvent } from 'react';
import { createProject } from '../../db/repo';
import type { FundingSource } from '../../engine/types';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { Button, Field, PageHeader, Panel, useToast } from '../ui';

export const FUNDING_SOURCES: FundingSource[] = ['CDBG', 'CDBG-DR', 'HOME', 'EPA SRF', 'USDA RD', 'FHWA', 'FAA', 'Other federal', 'State prevailing wage'];

export function NewProjectPage() {
  useDocumentTitle('New project');
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    projectNumber: '',
    owner: '',
    location: '',
    fundingSource: 'CDBG' as FundingSource,
    wdLockDate: '',
    reviewerName: '',
    reviewerTitle: '',
    reviewerOrg: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      const project = await createProject({
        name: form.name,
        projectNumber: form.projectNumber,
        owner: form.owner,
        location: form.location,
        fundingSource: form.fundingSource,
        wdLockDate: form.wdLockDate || null,
        reviewer: { name: form.reviewerName.trim(), title: form.reviewerTitle.trim(), organization: form.reviewerOrg.trim(), email: '', phone: '' },
      });
      navigate(projectPath(project.id, 'wd'));
    } catch (err) {
      toast(`Could not create the project: ${(err as Error).message}`, 'bad');
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <PageHeader title="New project" crumbs={<a href="#/">Projects</a>} subtitle="Next you'll add the wage determination, then the contractors and their payrolls." />
      <form onSubmit={submit}>
        <Panel
          title="Contract"
          footer={
            <>
              <Button onClick={() => navigate('/')}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy || !form.name.trim()}>
                Create project
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Project name" className="span-2">
              <input className="input" value={form.name} onChange={set('name')} required autoFocus placeholder="e.g. Main Street Water Line Replacement" />
            </Field>
            <Field label="Project / contract no.">
              <input className="input" value={form.projectNumber} onChange={set('projectNumber')} placeholder="Grant or contract number" />
            </Field>
            <Field label="Funding source">
              <select className="select" value={form.fundingSource} onChange={set('fundingSource')}>
                {FUNDING_SOURCES.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </Field>
            <Field label="Owner / grantee / awarding agency">
              <input className="input" value={form.owner} onChange={set('owner')} />
            </Field>
            <Field label="Project location">
              <input className="input" value={form.location} onChange={set('location')} placeholder="City, county" />
            </Field>
            <Field label="Wage determination lock date" hint="Bid opening or award date. It decides which WD modification applies.">
              <input className="input" type="date" value={form.wdLockDate} onChange={set('wdLockDate')} />
            </Field>
          </div>
          <h3 style={{ margin: '20px 0 10px' }}>Reviewer</h3>
          <div className="form-grid">
            <Field label="Your name">
              <input className="input" value={form.reviewerName} onChange={set('reviewerName')} />
            </Field>
            <Field label="Title">
              <input className="input" value={form.reviewerTitle} onChange={set('reviewerTitle')} placeholder="Labor Standards Officer" />
            </Field>
            <Field label="Organization">
              <input className="input" value={form.reviewerOrg} onChange={set('reviewerOrg')} />
            </Field>
          </div>
        </Panel>
      </form>
    </div>
  );
}
