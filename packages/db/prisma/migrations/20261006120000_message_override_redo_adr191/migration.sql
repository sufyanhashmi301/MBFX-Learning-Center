-- ADR-191: a Sync "reset" marks a language's machine interface strings for
-- re-translation in place, so they keep their text until the new one lands.
ALTER TABLE `message_overrides` ADD COLUMN `redo` BOOLEAN NOT NULL DEFAULT false;
