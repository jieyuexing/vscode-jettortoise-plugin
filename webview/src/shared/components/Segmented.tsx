import "./panel-chrome.css";

/** 标题行里的二选一／多选一分段按钮；按钮高度与行内下拉框一致。 */
export function Segmented<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: T;
  items: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="panel-segmented">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
