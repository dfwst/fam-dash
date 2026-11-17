import { BrowserRouter } from 'react-router-dom';
import AuthGate from './auth/AuthGate';
import Shell from './app/Shell';
import { captureJoinToken } from './lib/join';

captureJoinToken(); // an invite link (/join/<token>) is remembered before sign-in

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <Shell />
      </AuthGate>
    </BrowserRouter>
  );
}
