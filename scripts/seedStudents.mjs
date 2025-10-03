import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
if(!url || !service){ 
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); 
  process.exit(1) 
}
const supa = createClient(url, service)

const CLASS = 'A'
const COUNT = 28

for(let i=1;i<=COUNT;i++){
  const num = String(i).padStart(2,'0')
  const username = `${CLASS}_${num}`
  const email = `${username}@local`
  const password = `${username}!` // replace with your real passwords to match iPad keychain
  const { data:u, error:e1 } = await supa.auth.admin.createUser({ email, password, user_metadata:{ username } })
  if(e1){ console.error('user',username,e1.message); continue }
  const { error:e2 } = await supa.from('students').insert({ id:u.user.id, username, display_number:i, class_letter:CLASS, is_active:true })
  if(e2) console.error('student',username,e2.message)
}
console.log('Seeded A_01…A_28')
