import type { DiscoverCharacter } from "../types";

function CharacterCard({ character }: { character: DiscoverCharacter }) {
  const matches = `${character.matchCount} match${character.matchCount === 1 ? "" : "es"}`;
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline gap-2">
        <h3 className="font-medium">{character.name}</h3>
        <span className="text-muted-foreground text-xs">{matches}</span>
      </div>
      {character.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {character.tags.slice(0, 6).map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {character.segments.map((seg) => (
          <li
            key={`${seg.chatId}:${seg.segIndex}`}
            className="border-border border-l-2 pl-2 text-muted-foreground text-sm"
          >
            {seg.snippet.trim()}…
          </li>
        ))}
      </ul>
    </li>
  );
}

export function DiscoverResults({ characters }: { characters: DiscoverCharacter[] }) {
  if (characters.length === 0) {
    return <p className="text-muted-foreground text-sm">No characters matched.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {characters.map((character) => (
        <CharacterCard key={character.characterId} character={character} />
      ))}
    </ul>
  );
}
