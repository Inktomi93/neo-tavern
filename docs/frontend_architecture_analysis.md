# Frontend Architecture Analysis: Astra Projecta vs Marinara Engine

This document outlines the frontend architectural patterns of `astra-projecta` and `marinara-engine` to inform the UI design of `neo-tavern`.

## 1. Responsive Architecture

### **Astra Projecta**
Astra uses **Platform-Specific Layout Shells**. It physically separates the top-level app into distinct modules for desktop and mobile:
- `src/app/desktop`
- `src/app/mobile`
- `src/app/shared` (for runtime and routing)

Astra manages responsiveness by mounting entirely different DOM structures depending on the detected platform or viewport, rather than relying strictly on CSS. Components are shared via a feature-sliced package directory, but the overarching layout managers and interactions are explicitly separated.

### **Marinara Engine**
Marinara uses a **Unified App Shell with Adaptive Logic**. It relies on a single `AppShell.tsx` component that manages the layout for all screen sizes.
- Responsiveness is primarily handled using **Tailwind CSS breakpoints** (e.g., `md:`, `lg:` classes) coupled with **JavaScript window observation**.
- In `AppShell.tsx`, it uses `window.matchMedia("(max-width: 767px)")` and `ResizeObserver` to detect when the main content area overflows or shrinks, conditionally hiding sidebars or triggering compact modes automatically.

**Takeaway for `neo-tavern`:** Marinara's unified approach is more standard for modern React applications and reduces duplication, but its implementation in `AppShell.tsx` is highly monolithic. A unified shell with strict feature boundaries is recommended.

---

## 2. Feature Isolation & Component Vibe

### **Astra Projecta**
Astra employs **Feature Slicing** and a **Hybrid Vanilla/React Mounting System**.
- **Monorepo-style structure:** Logic is divided under `src/packages/features/` (e.g., `ai-settings`, `chat-library`, `persona`), enforcing strict boundaries and public API contracts (`index.js`).
- **Hybrid Rendering:** Astra heavily utilizes Vanilla JS `document.createElement` for its core structural layouts to remain compatible with SillyTavern's architecture. It then uses React's `createRoot` to render isolated React components ("islands") inside these vanilla containers.

### **Marinara Engine**
Marinara uses a **Global Component Dump** with massive, tightly-coupled files.
- **Lack of isolation:** Almost all UI code is dumped into domain-based folders inside `src/components/` (e.g., `components/chat`, `components/layout`). There is a `features/` folder, but it is practically abandoned (only containing one feature).
- **Massive Components:** Components are not well-abstracted. For example, `ChatArea.tsx` exceeds 2,200 lines of code, intertwining layout, API data fetching, and business logic.
- **Tight Coupling:** Components are heavily tied to global stores and API hooks, making them hard to test or reuse outside their exact contexts.

**Takeaway for `neo-tavern`:** Astra's feature-slicing approach (`packages/features`) is highly superior for maintainability. We should adopt feature-based folder structures but stick purely to React (avoiding Astra's vanilla DOM manipulation), while keeping components small and decoupled, avoiding Marinara's massive God-components.

---

## 3. State Management

### **Astra Projecta**
Astra uses a **Custom Vanilla Pub/Sub Store**.
- Under `src/packages/core/state`, it implements a bespoke `createGlobalStateStore` backed by `localStorage`.
- The store uses basic `subscribe`, `getState`, and `setState` methods. Since Astra relies heavily on vanilla JS layouts, this store acts as an agnostic data layer that both vanilla logic and React components can listen to. It does not use standard libraries like Redux or Zustand.

### **Marinara Engine**
Marinara uses **Zustand + React Query**.
- **Zustand:** Heavily relied upon for client-side state. It contains multiple massive stores inside `src/stores/` (e.g., `ui.store.ts` is nearly 80KB and manages everything from font sizes to panel widths). It makes extensive use of the `persist` middleware for `localStorage`.
- **TanStack React Query:** Used for server state, API fetching, and caching (`useQuery`, `useMutation`).

**Takeaway for `neo-tavern`:** Marinara's choice of tools (`Zustand` + `React Query`) is excellent and idiomatic for modern React. However, its execution is flawed due to bloated stores (like `ui.store.ts`). `neo-tavern` should use Zustand, but split stores along feature boundaries rather than dumping everything into monolithic global stores.
