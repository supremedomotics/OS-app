import { useState } from "react";

/** Password input with a show/hide toggle so the installer can verify what they typed. */
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
        style={{ width: "100%", paddingRight: 64, boxSizing: "border-box" }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        style={{
          position: "absolute",
          top: "50%",
          right: 6,
          transform: "translateY(-50%)",
          background: "transparent",
          border: 0,
          color: "var(--aureon-color-gold-400)",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}
