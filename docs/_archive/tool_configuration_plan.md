# Frontend Tooling & Configuration Plan

This document tracks the specific libraries we are installing to build the `neo-tavern` frontend. Before installing or integrating any of these tools, a research subagent will look up the modern best practices (React 19 + Tailwind v4) for configuring them to ensure we don't adopt outdated or messy patterns.

## 1. UI Primitives & Styling (The `shadcn/ui` Base)
- **`clsx` & `tailwind-merge`**: Used together to safely merge conditional Tailwind CSS classes without specificity collisions.
- **`class-variance-authority` (CVA)**: Used to define component variants (e.g., `button({ variant: 'destructive', size: 'sm' })`).
- **`lucide-react`**: The standard icon set.
- **`tw-animate-css`**: Provides Tailwind v4 animation utilities (replaces the older `tailwindcss-animate` for v4 compatibility).

## 2. Interactive UI Components
- **`sonner`**: An opinionated toast notification library used by shadcn for alerts (e.g., "Chat successfully forked").

## 3. Global & Local State Management
- **`zustand`**: A small, fast, unopinionated state-management library. We need best practices on how to structure multiple small feature-stores rather than one massive global store, and how to safely persist state to `localStorage` if necessary.

## 4. Forms & Validation
- **`react-hook-form`**: For performant, uncontrolled form inputs (crucial for massive character/persona editors).
- **`@hookform/resolvers`**: To connect `react-hook-form` directly to our existing `zod` schemas for bulletproof type-safe validation.

## 5. Performance & Rendering
- **`@tanstack/react-virtual`**: Headless UI for virtualizing long lists (the 400+ character grid and the chat message history).
- **`react-markdown` + `remark-gfm` + `rehype-sanitize`**: For safely parsing and rendering AI outputs as Markdown without risking XSS or blowing up the DOM.
