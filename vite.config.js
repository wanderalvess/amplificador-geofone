import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// HTTPS is required for getUserMedia/geolocation when opening from the phone via LAN IP.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true, port: 5173 },
})
