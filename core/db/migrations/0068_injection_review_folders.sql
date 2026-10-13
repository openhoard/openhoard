-- An admin's "not an injection" review holds while the file is in the folders it was in when
-- reviewed (core/catalog reviewedNotInjection()): folder names are scored with the file's name
-- and reach readers' cards. Reviews from before this have no folders recorded and cover nothing
-- from now on, as 0065 did for titles: a cleared file is judged again at its next enrichment.
ALTER TABLE "injection_reviews" ADD COLUMN "folders" text[];