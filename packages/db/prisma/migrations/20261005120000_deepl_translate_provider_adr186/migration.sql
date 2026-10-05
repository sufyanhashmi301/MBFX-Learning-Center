-- ADR-186: DeepL as a second translation provider.
-- The provider row names its service; existing installs stay on Google.
ALTER TABLE `translate_provider`
  ADD COLUMN `kind` ENUM('GOOGLE', 'DEEPL') NOT NULL DEFAULT 'GOOGLE';

-- Each usage row records which service it called. Every row written before
-- this migration was a Google call or a refusal on the way to one.
ALTER TABLE `translate_usage`
  ADD COLUMN `provider` ENUM('GOOGLE', 'DEEPL') NULL;

UPDATE `translate_usage` SET `provider` = 'GOOGLE' WHERE `status` <> 'REFUSED';
