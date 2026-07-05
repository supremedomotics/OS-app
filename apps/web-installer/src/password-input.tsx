import { useState } from "react";

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

/** Password input with a show/hide eye icon at the right end so the installer can verify what they typed. */
export function PasswordInput({
  value,
  onChange,
  placeholder = "Password",
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative", ...style }}>
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width: "100%", paddingRight: 44, boxSizing: "border-box" }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        style={{
          position: "absolute",
          top: "50%",
          right: 6,
          transform: "translateY(-50%)",
          display: "inline-flex",
          alignItems: "center",
          background: "transparent",
          border: 0,
          color: "var(--aureon-color-text-secondary)",
          cursor: "pointer",
          padding: 6,
        }}
      >
        <EyeIcon off={show} />
      </button>
    </div>
  );
}
