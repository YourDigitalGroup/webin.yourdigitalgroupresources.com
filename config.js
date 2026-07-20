// Connected to the 44i intake-portal Supabase project (Jul 2026).
// The anon key is public by design — access is enforced by row level
// security, not by hiding this key.
const CONFIG = {
  SUPABASE_URL: "https://lbuqtjgjlshthkymfgef.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxidXF0amdqbHNodGhreW1mZ2VmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2OTQ5NTMsImV4cCI6MjA5OTI3MDk1M30.ApP9NhllEDbU3YbzdaTfV0GsbnglC5umbX4-dyMN-RQ",
  BUCKET: "intake-assets",

  // false = no password screen; visitors are signed in anonymously so the
  // database still works. Requires Dashboard > Authentication > Sign In / Up >
  // "Allow anonymous sign-ins" to be ON. Set true to restore the login gate.
  REQUIRE_LOGIN: true,
};
