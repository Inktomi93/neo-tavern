ALTER TABLE `chats` ADD `pinned_persona_id` text REFERENCES personas(id) ON DELETE set null;
