export function GraphLegend({ compact = false }: { compact?: boolean }) {
  const items = [
    { label: "Question", className: "swatch swatch--question" },
    { label: "Claim", className: "swatch swatch--claim" },
    { label: "Counterclaim", className: "swatch swatch--counterclaim" },
    { label: "Evidence", className: "swatch swatch--evidence" },
    { label: "Gap", className: "swatch swatch--gap" }
  ];

  return (
    <div className={compact ? "legend legend--compact" : "legend"}>
      {items.map((item) => (
        <span key={item.label} className="legend__item">
          <span className={item.className} />
          {item.label}
        </span>
      ))}
    </div>
  );
}
