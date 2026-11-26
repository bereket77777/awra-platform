import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseOptions =
  import.meta.env.DEV && import.meta.env.VITE_TAB_SESSIONS === "1"
    ? { auth: { storage: window.sessionStorage, storageKey: "awra-dev-auth" } }
    : undefined;

const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, supabaseOptions)
    : null;

export default supabase;
