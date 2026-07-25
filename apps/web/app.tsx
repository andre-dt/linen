// =====================================================================
// apps/web/src/app.tsx — the shell, the auth gate, and the routes.
//
// The app opens on the LOGIN screen by default. Only once there is a live
// session — which a returning user with a valid cookie has without
// signing in again — does it mount the router and its routes:
//
//   loading    -> a brief splash while /auth/me resolves
//   signed-out -> Login
//   signed-in  -> <Router>: "/" = Dashboard, "/project/:id" = Project
//
// The auth gate lives OUTSIDE the router: there is no point routing a
// signed-out user. Once signed in, real URLs take over — /project/<uuid>
// is a deep link that survives a refresh.
// =====================================================================

import { Match, Switch, onMount } from "solid-js"
import { Router, Route } from "@solidjs/router"
import { createAuth, type Auth } from "./auth"
import { Login } from "./screens/login"
import { Dashboard } from "./screens/dashboard"
import { Project } from "./screens/project"

export function App() {
  const auth = createAuth()

  // Ask the server who we are before painting anything but the splash.
  onMount(() => auth.refresh())

  return (
    <Switch fallback={<Splash />}>
      <Match when={auth.status() === "loading"}>
        <Splash />
      </Match>

      <Match when={auth.status() === "signed-out"}>
        <Login auth={auth} />
      </Match>

      <Match when={auth.status() === "signed-in"}>
        <Router>
          <Route path="/" component={() => <Dashboard auth={auth} />} />
          {/* Both the project and its feature sub-route render the same
              screen; the presence of :uuid opens that feature's HUD. */}
          <Route path="/project/:id" component={() => <Project auth={auth} />} />
          <Route path="/project/:id/features/:uuid" component={() => <Project auth={auth} />} />
          {/* Anything else falls back to the dashboard. */}
          <Route path="*" component={() => <Dashboard auth={auth} />} />
        </Router>
      </Match>
    </Switch>
  )
}

export type { Auth }

function Splash() {
  return (
    <div class="splash-scene">
      <div class="splash-mark">◆</div>
    </div>
  )
}
