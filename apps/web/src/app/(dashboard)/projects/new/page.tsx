import Link from "next/link";
import { ProjectForm } from "../../../../components/forms/ProjectForm";
import { dashboardOwner } from "../../../../server/dashboard";

export default async function NewProject() {
  await dashboardOwner();

  return (
    <div className="page narrow">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span>›</span>
        <span>New project</span>
      </nav>
      <span className="eyebrow">CONNECT AN APPLICATION</span>
      <h1>Create a project</h1>
      <p className="muted">
        One project for each SPA. Add the exact origins that will send errors.
      </p>
      <section className="panel form-panel">
        <ProjectForm />
      </section>
    </div>
  );
}
