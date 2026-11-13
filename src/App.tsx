import { BrowserRouter } from 'react-router-dom';
import AuthGate from './auth/AuthGate';
import Shell from './app/Shell';

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <Shell />
      </AuthGate>
    </BrowserRouter>
  );
}
