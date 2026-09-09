export function ProjectSelect({
  projects,
  selected,
}: {
  projects: { id: string; name: string }[];
  selected?: string;
}) {
  return (
    <label className="filter-field">
      Project
      <select aria-label="Project" name="project" defaultValue={selected ?? ""}>
        <option value="">All projects</option>
        {projects.map((project) => (
          <option value={project.id} key={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}
