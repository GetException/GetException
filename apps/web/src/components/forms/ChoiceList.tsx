"use client";

export function ChoiceList({
  label,
  name,
  options,
  selected = [],
}: {
  label: string;
  name: string;
  options: { id: string; label: string }[];
  selected?: string[];
}) {
  return (
    <fieldset className="choice-list">
      <legend>{label}</legend>
      {options.length ? (
        options.map((option) => (
          <label key={option.id} className="choice-item">
            <input
              type="checkbox"
              name={name}
              value={option.id}
              defaultChecked={selected.includes(option.id)}
            />
            <span>{option.label}</span>
          </label>
        ))
      ) : (
        <p className="muted small">None available yet.</p>
      )}
    </fieldset>
  );
}
