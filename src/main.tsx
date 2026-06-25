import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Note: no React.StrictMode. Its dev-only double-invoke of effects would create
// and dispose the WebGL SceneManager twice on mount, briefly running two render
// loops against one canvas (a tearing source). The screensaver gains nothing
// from StrictMode's checks, so we mount once for a single, stable GL context.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
