-- phase: migrate
-- Every creator world that existed before sharing is registered once. A published world is Everyone;
-- a draft or a hidden world is Only me. `people` is never in the column: it is a share.v1 audience
-- only, set by the Share sheet before a world is published.
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT 'games', 'world', w.id,
       CASE WHEN w.owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'
            THEN jsonb_build_object('type', 'user', 'id', w.owner_subject)
            ELSE jsonb_build_object('type', 'service', 'id', 'games') END,
       CASE WHEN w.status = 'published' THEN 'public' ELSE 'private' END
FROM creator_worlds w
ON CONFLICT (service, kind, resource_id) DO NOTHING;
