import { render, screen } from "@testing-library/react";
import { describe, expect, type Mock, test, vi } from "vitest";
import { trpc } from "../../../lib/trpc";
import { ChatHeader } from "./ChatHeader";

// Mock the tRPC hooks
vi.mock("../../../lib/trpc", () => ({
  trpc: {
    chat: {
      get: {
        useQuery: vi.fn(),
      },
      setProvider: {
        useMutation: vi.fn().mockReturnValue({ mutate: vi.fn() }),
      },
    },
    models: {
      useQuery: vi.fn().mockReturnValue({ data: { available: [], defaultId: "test-model" } }),
    },
    rawModels: {
      useQuery: vi.fn().mockReturnValue({ data: [] }),
    },
    preset: {
      list: {
        useQuery: vi.fn().mockReturnValue({ data: [] }),
      },
    },
  },
}));

describe("ChatHeader Component", () => {
  test("renders the loading skeleton when data is missing", () => {
    // Arrange: Mock the query to return no data yet
    (trpc.chat.get.useQuery as Mock).mockReturnValue({ data: undefined });

    // Act
    render(<ChatHeader chatId="123" />);

    // Assert
    expect(screen.getByTestId("chat-header-loading")).toBeInTheDocument();
  });

  test("renders chat metadata, context meter, and pickers when loaded", () => {
    // Arrange
    (trpc.chat.get.useQuery as Mock).mockReturnValue({
      data: {
        title: "Test Chat Title",
        characterName: "Test Char",
        model: "gpt-4o",
        api: "agent-sdk",
      },
    });

    // Act
    render(<ChatHeader chatId="123" />);

    // Assert
    expect(screen.getByText("Test Chat Title")).toBeInTheDocument();
    expect(screen.getByTestId("model-picker-select")).toBeInTheDocument();
    expect(screen.getByTestId("preset-picker-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("context-meter")).toBeInTheDocument();
  });
});
