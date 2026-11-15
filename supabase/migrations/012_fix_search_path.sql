-- Security advisor: pin search_path on private.is_personal_domain (pg_catalog is always searched)
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='private' and p.proname='is_personal_domain' loop
    execute format('alter function %s set search_path = %L', f, '');
  end loop;
end $$;
