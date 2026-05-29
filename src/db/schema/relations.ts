import { relations } from "drizzle-orm";
import { assets } from "./assets";
import { characters, characterVersions, personas } from "./characters";
import { chatEvents, chats, messages, messageVariants } from "./chats";
import { presets, presetVersions } from "./config";
import { chatDigests, chatSegments } from "./search";
import { sessionEntries } from "./session";
import { characterTags, chatTags, personaTags, presetTags, tags } from "./tags";
import { users } from "./tenancy";
import { characterVersionWorldEntries, chatWorldEntries, worldBooks, worldEntries } from "./world";

export const usersRelations = relations(users, ({ many }) => ({
  chats: many(chats),
  characters: many(characters),
  personas: many(personas),
  presets: many(presets),
  worldBooks: many(worldBooks),
}));

export const chatsRelations = relations(chats, ({ one, many }) => ({
  owner: one(users, {
    fields: [chats.ownerId],
    references: [users.id],
  }),
  characterVersion: one(characterVersions, {
    fields: [chats.characterVersionId],
    references: [characterVersions.id],
  }),
  activePersona: one(personas, {
    fields: [chats.personaId],
    references: [personas.id],
    relationName: "activePersona",
  }),
  pinnedPersona: one(personas, {
    fields: [chats.pinnedPersonaId],
    references: [personas.id],
    relationName: "pinnedPersona",
  }),
  presetVersion: one(presetVersions, {
    fields: [chats.presetVersionId],
    references: [presetVersions.id],
  }),
  parentChat: one(chats, {
    fields: [chats.parentChatId],
    references: [chats.id],
    relationName: "parentChat",
  }),
  messages: many(messages),
  chatEvents: many(chatEvents),
  sessionEntries: many(sessionEntries),
  chatWorldEntries: many(chatWorldEntries),
  chatSegments: many(chatSegments),
  chatDigests: many(chatDigests),
  tags: many(chatTags),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
  presetVersion: one(presetVersions, {
    fields: [messages.presetVersionId],
    references: [presetVersions.id],
  }),
  parentMessage: one(messages, {
    fields: [messages.parentId],
    references: [messages.id],
    relationName: "parentMessage",
  }),
  variants: many(messageVariants),
}));

export const messageVariantsRelations = relations(messageVariants, ({ one }) => ({
  message: one(messages, {
    fields: [messageVariants.messageId],
    references: [messages.id],
  }),
}));

export const chatEventsRelations = relations(chatEvents, ({ one }) => ({
  chat: one(chats, {
    fields: [chatEvents.chatId],
    references: [chats.id],
  }),
  message: one(messages, {
    fields: [chatEvents.messageId],
    references: [messages.id],
  }),
}));

export const sessionEntriesRelations = relations(sessionEntries, ({ one }) => ({
  chat: one(chats, {
    fields: [sessionEntries.chatId],
    references: [chats.id],
  }),
}));

export const personasRelations = relations(personas, ({ one, many }) => ({
  owner: one(users, {
    fields: [personas.ownerId],
    references: [users.id],
  }),
  avatar: one(assets, {
    fields: [personas.avatarAssetId],
    references: [assets.id],
  }),
  tags: many(personaTags),
}));

export const charactersRelations = relations(characters, ({ one, many }) => ({
  owner: one(users, {
    fields: [characters.ownerId],
    references: [users.id],
  }),
  currentVersion: one(characterVersions, {
    fields: [characters.currentVersionId],
    references: [characterVersions.id],
    relationName: "currentVersion",
  }),
  versions: many(characterVersions, { relationName: "versions" }),
  tags: many(characterTags),
}));

export const characterVersionsRelations = relations(characterVersions, ({ one, many }) => ({
  character: one(characters, {
    fields: [characterVersions.characterId],
    references: [characters.id],
    relationName: "versions",
  }),
  avatar: one(assets, {
    fields: [characterVersions.avatarAssetId],
    references: [assets.id],
  }),
  cvWorldEntries: many(characterVersionWorldEntries),
}));

export const presetsRelations = relations(presets, ({ one, many }) => ({
  owner: one(users, {
    fields: [presets.ownerId],
    references: [users.id],
  }),
  currentVersion: one(presetVersions, {
    fields: [presets.currentVersionId],
    references: [presetVersions.id],
    relationName: "currentVersion",
  }),
  versions: many(presetVersions, { relationName: "versions" }),
  tags: many(presetTags),
}));

export const presetVersionsRelations = relations(presetVersions, ({ one }) => ({
  preset: one(presets, {
    fields: [presetVersions.presetId],
    references: [presets.id],
    relationName: "versions",
  }),
}));

export const worldBooksRelations = relations(worldBooks, ({ one, many }) => ({
  owner: one(users, {
    fields: [worldBooks.ownerId],
    references: [users.id],
  }),
  entries: many(worldEntries),
}));

export const worldEntriesRelations = relations(worldEntries, ({ one, many }) => ({
  worldBook: one(worldBooks, {
    fields: [worldEntries.worldBookId],
    references: [worldBooks.id],
  }),
  chatWorldEntries: many(chatWorldEntries),
  cvWorldEntries: many(characterVersionWorldEntries),
}));

export const chatWorldEntriesRelations = relations(chatWorldEntries, ({ one }) => ({
  chat: one(chats, {
    fields: [chatWorldEntries.chatId],
    references: [chats.id],
  }),
  entry: one(worldEntries, {
    fields: [chatWorldEntries.entryId],
    references: [worldEntries.id],
  }),
}));

export const characterVersionWorldEntriesRelations = relations(
  characterVersionWorldEntries,
  ({ one }) => ({
    characterVersion: one(characterVersions, {
      fields: [characterVersionWorldEntries.characterVersionId],
      references: [characterVersions.id],
    }),
    entry: one(worldEntries, {
      fields: [characterVersionWorldEntries.entryId],
      references: [worldEntries.id],
    }),
  }),
);

export const chatSegmentsRelations = relations(chatSegments, ({ one }) => ({
  chat: one(chats, {
    fields: [chatSegments.chatId],
    references: [chats.id],
  }),
  owner: one(users, {
    fields: [chatSegments.ownerId],
    references: [users.id],
  }),
  characterVersion: one(characterVersions, {
    fields: [chatSegments.characterVersionId],
    references: [characterVersions.id],
  }),
}));

export const chatDigestsRelations = relations(chatDigests, ({ one }) => ({
  chat: one(chats, {
    fields: [chatDigests.chatId],
    references: [chats.id],
  }),
  owner: one(users, {
    fields: [chatDigests.ownerId],
    references: [users.id],
  }),
  characterVersion: one(characterVersions, {
    fields: [chatDigests.characterVersionId],
    references: [characterVersions.id],
  }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  characterTags: many(characterTags),
  chatTags: many(chatTags),
  personaTags: many(personaTags),
  presetTags: many(presetTags),
}));

export const characterTagsRelations = relations(characterTags, ({ one }) => ({
  character: one(characters, {
    fields: [characterTags.characterId],
    references: [characters.id],
  }),
  tag: one(tags, {
    fields: [characterTags.tagId],
    references: [tags.id],
  }),
}));

export const chatTagsRelations = relations(chatTags, ({ one }) => ({
  chat: one(chats, {
    fields: [chatTags.chatId],
    references: [chats.id],
  }),
  tag: one(tags, {
    fields: [chatTags.tagId],
    references: [tags.id],
  }),
}));

export const personaTagsRelations = relations(personaTags, ({ one }) => ({
  persona: one(personas, {
    fields: [personaTags.personaId],
    references: [personas.id],
  }),
  tag: one(tags, {
    fields: [personaTags.tagId],
    references: [tags.id],
  }),
}));

export const presetTagsRelations = relations(presetTags, ({ one }) => ({
  preset: one(presets, {
    fields: [presetTags.presetId],
    references: [presets.id],
  }),
  tag: one(tags, {
    fields: [presetTags.tagId],
    references: [tags.id],
  }),
}));
