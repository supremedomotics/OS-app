import { useState } from "react";

/**
 * Password input with a show/hide toggle, so the user can reveal what they typed and catch a typo
 * before submitting. Obscured by default; the button flips the field type.
 */
export function PasswordInput({
  value,
  onChange,
  placeholder = "Password",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-field">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}
