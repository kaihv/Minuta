import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import Layout from "@/components/Layout";
import { Spinner } from "@/components/ui";
import { BRAND } from "@/config/brand";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { ThemeProvider } from "@/hooks/useTheme";
import { configMissing } from "@/lib/supabase";
import Ajustes from "@/pages/Ajustes";
import Grabar from "@/pages/Grabar";
import Login from "@/pages/Login";
import Reunion from "@/pages/Reunion";
import Reuniones from "@/pages/Reuniones";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000 } },
});

function Routed() {
  const { session, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!session) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Reuniones />} />
        <Route path="reunion/:id" element={<Reunion />} />
        <Route path="grabar" element={<Grabar />} />
        <Route path="ajustes" element={<Ajustes />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function ConfigMissing() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <h1>Falta conectar Supabase</h1>
      <p className="mt-3 text-muted-foreground">
        Copia <code>.env.example</code> como <code>.env</code> y completa VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY con los datos de tu proyecto
        (Supabase, Settings, API). Después reinicia <code>npm run dev</code>.
      </p>
    </div>
  );
}

document.title = BRAND.name;

export default function App() {
  if (configMissing) return <ConfigMissing />;
  return (
    <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routed />
        </AuthProvider>
      </BrowserRouter>
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: "font-sans" }} />
    </QueryClientProvider>
    </ThemeProvider>
  );
}
