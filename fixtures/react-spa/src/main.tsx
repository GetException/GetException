import { useState } from "react";
import { createRoot } from "react-dom/client";
import * as GetException from "@getexception/react";

function Broken() {
  throw new Error("React fixture boundary error");

  return null;
}

function App() {
  const [connected, setConnected] = useState(false);
  const [broken, setBroken] = useState(false);

  return (
    <main>
      <h1>React SPA fixture</h1>
      {!connected && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;

            GetException.init({
              dsn: String(new FormData(form).get("dsn")),
              environment: "development",
              release: "react-fixture@abcdef0123456789abcdef0123456789abcdef01",
            });
            form.reset();
            setConnected(true);
          }}
        >
          <label>
            DSN <input name="dsn" type="password" autoComplete="off" />
          </label>
          <button>Connect</button>
        </form>
      )}
      <button onClick={() => setBroken(true)}>Trigger boundary</button>
      <GetException.ErrorBoundary
        fallback={<p role="status">The application is still available.</p>}
      >
        {broken ? <Broken /> : <p>Ready</p>}
      </GetException.ErrorBoundary>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
