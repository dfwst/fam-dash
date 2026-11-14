-- Short label shown on each to-do line ("DFWST", "Church", "Personal")
alter table public.connected_accounts add column nickname text;
update public.connected_accounts set nickname = case email
  when 'jwilliams@dfwsmarttech.com' then 'DFWST'
  when 'jwilliams@lfwired.org' then 'Church'
  when 'jasonrobwill@gmail.com' then 'Personal'
  when 'tsajason@gmail.com' then 'Old personal'
  when 'blakeandjasonwill@gmail.com' then 'Shared'
  else split_part(email, '@', 1) end;
