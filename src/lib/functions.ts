import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Call an Edge Function. Throws Error(code) using the function's own { error } code
// (e.g. 'needs-reconnect') so screens can show a specific message.
export async function callFn<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) {
    let code = error.message;
    if (error instanceof FunctionsHttpError) {
      code = (await error.context.json().catch(() => null))?.error ?? code;
    }
    throw new Error(code);
  }
  return data as T;
}
