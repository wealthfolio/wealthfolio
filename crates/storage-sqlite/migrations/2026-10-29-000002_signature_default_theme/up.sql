-- Signature, with its Sans font, becomes the default for new profiles. A profile stores
-- a theme and a font only once someone picks them, so profiles that finished onboarding
-- without picking would switch on update. Store the look they had: Classic and Mono.
INSERT INTO app_settings (setting_key, setting_value)
SELECT 'theme_id', 'classic'
WHERE EXISTS (
    SELECT 1 FROM app_settings
    WHERE setting_key = 'onboarding_completed' AND setting_value = 'true'
)
AND NOT EXISTS (SELECT 1 FROM app_settings WHERE setting_key = 'theme_id');

INSERT INTO app_settings (setting_key, setting_value)
SELECT 'font', 'font-mono'
WHERE EXISTS (
    SELECT 1 FROM app_settings
    WHERE setting_key = 'onboarding_completed' AND setting_value = 'true'
)
AND NOT EXISTS (SELECT 1 FROM app_settings WHERE setting_key = 'font');
