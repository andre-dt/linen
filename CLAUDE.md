# Linen

CAD web paramétrico (estilo Onshape), 100% TypeScript, com kernel geométrico plugável.

## Princípios

1. **TypeScript é a linguagem de modelagem.** Onde o Onshape tem FeatureScript, nós temos TS + tipos. Features são funções tipadas; a "linguagem" é a API mais o sistema de tipos.
2. **Kernel abstrato.** Nenhum código acima da camada `kernel` importa OCCT. A primeira implementação é OCCT (WASM/bindings), o alvo futuro é Parasolid. O contrato é o **denominador comum** entre os dois — nada de vazar semântica específica de OCCT (ex.: `TopoDS_Shape`, `BRepBuilderAPI_*`).
3. **Server calcula, cliente desenha.** O kernel roda no server; o cliente recebe meshes + IDs topológicos e renderiza.
4. **Git é o banco.** O histórico do documento é um repositório git em disco (S3 em produção). MVCC de graça: branches, merge, commit = versão do documento.
5. **Determinismo.** Mesma feature tree + mesma versão do kernel ⇒ mesma geometria e **mesmos IDs topológicos**. Sem isso, referências quebram.

## Arquitetura

```
src/
  common/          kernel.ts  api.ts  feature.ts     compartilhado
  draft/           kernel.ts  api.ts  feature.ts     desenho 2D
  extrude/         kernel.ts  api.ts  feature.ts     extrusão

  container/       injeção de dependência: registro, proxy lazy
  protocol/        contrato cliente<->servidor: comandos + meshes
  server/          sessões, fila, regeneração, cache, git
  viewer/          WebGPU / WebGL2 + WASM (decode, picking, BVH)
  hud/             painel genérico em SolidJS

  kernel.ts  api.ts  features.ts                     barrels
```

Fora do `src/`: `packages/kernel-occt/` — o addon N-API (Rust) com OCCT linkado estaticamente.

### MVP

**draft + extrude + HUD + renderer + cliente/servidor.** O bastante para o ciclo completo: desenhar, extrudar, ver na tela, editar o parâmetro, ver regenerar, commitar no git.

Cortado do MVP, sem prejuízo da arquitetura (cada um é uma pasta nova, não uma refatoração):

- Features: `revolve`, `loft`, `sweep`, `fillet`, `chamfer`, `taper`, `shell`, `hole`, `pattern`, `mirror`, `bolt`, `mate`, `query`
- Solver 2D de constraints — os tipos já existem; `solve: false` usa geometria literal
- `module` (Feature Studio)
- Merge de branches

O que **não** dá para adiar, porque muda o formato persistido: expressões como árvore sintática, seletores por papel semântico, e o layout binário da mesh.

### Fluxo de um comando

```
cliente: cad.extrude(profile).distance(millimeters`12`).asNewBody()
  -> server: valida sessão (renova TTL)
  -> part: insere na árvore, marca dirty a jusante
  -> container: resolve a feature (lazy, cacheado)
  -> src/extrude/feature.ts: avalia expressões, invoca capability
  -> kernel-occt: opera geometria, tessela
  -> store-git: commit
  -> protocol: envia delta (meshes + IDs) via WS
  -> viewer: atualiza buffers
```

## Convenções de código

**Idioma: inglês.** Todo o código — identificadores, comentários, labels de UI, mensagens de erro. Documentação (`CLAUDE.md`) fica em português.

**Sem abreviação.** `context`, não `ctx`. `command`, não `cmd`. `selector`, não `sel`. `expression`, não `expr`. A exceção são siglas que são o termo canônico da área — usar a forma extensa é que soaria errado:

> BREP, NURBS, UV, DOF, ISO, ANSI, DIN, API, TTL, id, mm, rad, 2D, 3D

`Vector3`, `Matrix4`, `Point2` também ficam: são universais em computação gráfica.

**Nomes:**

| Elemento | Convenção | Exemplo |
|---|---|---|
| Arquivo | kebab-case | `common/kernel.ts`, `up-to-face.ts` |
| Tipo, interface | PascalCase | `ExtrudeInput`, `KernelSession` |
| **Tipo de função** | PascalCase | `EvaluateExpression`, `ReadMeshHeader` |
| Função, variável | camelCase | `evaluateExpression`, `outerDiameter` |
| Constante | SCREAMING_SNAKE | `BASE_CAPABILITIES`, `LINEAR_TOLERANCE` |
| String literal | kebab-case, `.` como separador | `"solid.extrude"`, `"operation-failed"`, `"up-to-face"` |

Funções são declaradas como **tipo nomeado + const**, não `declare function`:

```ts
export type ReadMeshHeader = (buffer: ArrayBuffer) => MeshHeader
export declare const readMeshHeader: ReadMeshHeader
```

O tipo fica citável e reusável (em injeção de dependência, em mocks de teste), em vez de preso à declaração.

**`| null` explícito, nunca `?`,** nos tipos persistidos: obriga a decidir na desserialização. Nos steps a propriedade simplesmente não existe até ser relevante.

## Estrutura

```
src/
  common/
    kernel.ts       handles, geometria, expressões, capabilities, adapter, mesh
    api.ts          seletores, comando, variáveis, fachada Cad
    feature.ts      CommandDef, steps, campos, a ponte para o HUD

  <feature>/
    kernel.ts       capabilities exigidas + papéis topológicos
    api.ts          steps + input persistido
    feature.ts      implementação + metadata

  kernel.ts         barrel: todos os <feature>/kernel.ts
  api.ts            barrel: todos os <feature>/api.ts
  features.ts       barrel: todos os <feature>/feature.ts + preset
```

Features: `draft`, `extrude`, `revolve`, `loft`, `sweep`, `fillet`, `chamfer`, `taper`, `shell`, `hole`, `pattern`, `mirror`, `bolt`, `mate`, `query`.

### As três camadas

| | `kernel.ts` | `api.ts` | `feature.ts` |
|---|---|---|---|
| Responde | o que o kernel deve saber fazer | o que o usuário escreve | como executa e como aparece |
| Contém | capabilities, papéis, tipos nativos | steps, input persistido | comandos, steps como dado, execução |
| Implementado por | `kernel-occt`, `kernel-parasolid` | — (só tipos) | esta feature |
| Muda quando | troca de kernel | muda a linguagem | muda a lógica ou o painel |

Dependência unidirecional: `api.ts` importa tipos de `kernel.ts`; `feature.ts` importa dos dois. Nunca o contrário.

Cada feature declara **suas próprias** capabilities em `<feature>/kernel.ts`, junto de quem usa, em vez de numa lista central que ninguém mantém.

### Ciclos

Dois mecanismos, dois problemas:

- **`import type`** resolve ciclos de **tipo**. É apagado na compilação, então não existe em runtime.
- **Injeção de dependência** resolve ciclos de **valor**. `bolt` chama `hole` em runtime; se importasse `holeFeature` diretamente, o ciclo voltaria.

O grafo de valor é uma estrela, não um ciclo:

```
        common/          (raiz — não importa feature nenhuma)
            ^
            |            (todas importam)
    draft  extrude  ...  mate
            ^
            |            (importa todas)
        features.ts
```

Os ciclos ficam no grafo de **uso**, resolvidos por proxy lazy: `context.cad.hole` só resolve na primeira chamada, quando `bolt` já terminou de criar.

O container distingue:

- **Ciclo de uso** (`bolt` chama `hole` que chama `bolt`) — legítimo, funciona.
- **Ciclo de criação** (`create()` chamando `create()`) — erro real, com o caminho completo na mensagem.

Regra: `create()` só captura o contexto. Nunca execute geometria nem chame `context.cad.*` ali.

## Comandos e HUD

Cada `<feature>/feature.ts` exporta um **array de comandos**. Um `CommandDef` é dado puro: identificação, papéis, capabilities, a máquina de steps, schema, migrações e execução.

O painel é **derivado** desse array, nunca escrito à parte — se fossem duas declarações, divergiriam na primeira mudança. O UI implementa ~10 widgets primitivos e nenhum componente por feature:

```
number-with-unit  checkbox  button-group  dropdown  viewport-picker
direction-picker  plane-picker  feature-list  point-list  grid
```

Feature nova = uma entrada de metadata, zero código de UI. Feature definida pelo usuário (`module`) usa o mesmo caminho, sem privilégio.

**Comparação com o Onshape:** lá o HUD sai de anotações nos parâmetros do FeatureScript — uma lista plana mais predicados de visibilidade. `definition.draftAngle` existe sempre, só fica oculto. Aqui é uma máquina de estados: o campo não existe no step nem no tipo até ser relevante. Daí decorrem: sem opcional que na verdade é condicional; ordem obrigatória; sem lógica de visibilidade no UI; undo por step.

`validateFeature` roda no CI e checa que a máquina de estados em dado e a em tipos não divergiram.

## API por steps

Operações são construídas por steps obrigatórios; cada step só expõe as propriedades relevantes naquele ponto. Pular step é erro de compilação.

```ts
cad.extrude(profile).distance(millimeters`12`).taper(degrees`2`).asNewBody()
cad.hole(disc).onFace(top, points).counterbore(millimeters`8.5`)
   .bore(millimeters`14`, millimeters`8`).through()
```

`?` e `| null` só quando a ausência tem significado semântico próprio (`shell().openFaces()` ausente = cavidade fechada). Nunca para "depende de um step anterior" — isso é estado de tipo.

## Parametricidade

Valores são **expressões**, não números. `millimeters`${outerDiameter} / 2`` produz uma árvore sintática que vai pro git e é reavaliada a cada regeneração — nunca vira `60`. Sem isso a relação se perde e o modelo não é paramétrico.

A árvore também alimenta o grafo de regeneração: é como se sabe que uma feature depende de `wallThickness`.

Variáveis: `length`, `angle`, `count`, `flag` (controla supressão), `choice`, `derived`. As tags validam dimensão — `millimeters`${diameter} + ${angle}`` não compila.

## Seletores e queries

Distinção que importa:

- **`Selector<T>` identifica** entidades — "as arestas circulares do topo".
- **`Query<T>` mede** — "qual o volume deste corpo?".

Seletor é resolvido pelo motor de seleção e devolve handles; query é resolvida pelo kernel e devolve valor. Ambos são **dados serializáveis**, entram no grafo de dependências, e query vira expressão via `asLength` — mantendo a relação viva.

## Versionamento

| Conceito | Git |
|---|---|
| commit automático por comando | commit (efêmero) |
| versão selada pelo usuário | tag anotada, **imutável** |
| workspace | branch |

O usuário decide quando selar. Referência entre projects é **sempre** a uma versão selada, nunca a um branch vivo — impede que a peça de um colega mude debaixo de você.

Diff e merge em nível de **feature**, não de texto: é o ganho de usar árvore de features como formato.

## Lições do CadQuery

CadQuery é a referência mais próxima do que queremos (TS no lugar do Python, mesma pilha OCCT). Vale copiar o que ele acertou e evitar deliberadamente o que ele errou.

### Copiar

**A arquitetura em camadas.** CadQuery separa `occ_impl` (wrappers finos sobre OCCT: `Shape`, `Face`, `Edge`) da API fluente `Workplane` por cima. A camada de baixo é utilizável sozinha. Nosso equivalente: `kernel-occt` deve ser usável sem `features`, e `features` sem `document`.

**Seletores como predicados re-deriváveis, não índices.** A ideia central do CadQuery é dizer *"a face de maior Z"* em vez de *"face #12"*. Índices são a origem do topological naming problem no FreeCAD. Vamos adotar o princípio — expresso em TS tipado, não numa mini-linguagem de string.

**Composição booleana de seletores.** `"|Z and >Y"`, `"not (<X or >X)"`. O poder disso é real. Em TS vira composição de funções: `and(parallelTo(Z), maxAlong(Y))` — mesma expressividade, com autocomplete e checagem em tempo de compilação.

**Seletores relacionais.** As adições mais recentes do CadQuery, `ancestors()` e `siblings()`, são as mais robustas justamente por expressarem *relação* ("as faces que contêm esta aresta") e não *coordenada*. Devem ser primitivas de primeira classe pra nós, não um extra.

**`AreaNthSelector`, `RadiusNthSelector`.** Seletores por propriedade intrínseca (área, raio, comprimento) sobrevivem a mudanças de orientação melhor que os direcionais. Incluir desde o início.

### Evitar

**A pilha implícita.** `Workplane` carrega uma lista invisível; `.circle(0.5)` depois de `.vertices()` cria silenciosamente N círculos, sem loop no código. Os próprios docs admitem que isso dificulta debug. **Nossos comandos são explícitos**: entrada nomeada, saída nomeada, sem estado oculto entre chamadas. Fan-out é um `map`, visível.

**Estado mutável compartilhado numa cadeia "imutável".** O `newObject` do CadQuery copia a lista de objetos mas **aliasa** o `ctx` — `pendingWires` é global à cadeia e removido destrutivamente. O método `toPending()` existe só pra remendar isso. **Nós não temos contexto mutável**: todo estado necessário está na entrada do comando.

**Índices em clusters com tolerância.** `>Z[1]` do CadQuery não retorna a segunda face — retorna o segundo *grupo* de faces coplanares dentro de 1e-4. Pior: elementos cujo `key()` lança erro são descartados **silenciosamente**, deslocando todos os índices seguintes. **Regra nossa**: seletor que resolve para uma contagem diferente da esperada é **erro**, nunca resultado silencioso.

**Exclusões silenciosas.** No CadQuery, arestas não-lineares não são selecionadas por nenhum seletor de string exceto `%` e `>>` — `.edges("|Z")` num cilindro retorna nada. E faces não-planares são avaliadas no centro de massa, com resultados que a própria doc chama de "bastante inesperados". **Ou o seletor lida com o caso, ou ele falha explicitamente.**

**Múltiplas mini-linguagens em string.** CadQuery tem três gramáticas distintas: seletores (`>Z`), queries de assembly (`nome?tag@faces@>Z`) e nomes de plano (`"XY"`). Nenhuma é checada em tempo de compilação. **Nós temos zero**: tudo é TS tipado. É a razão de existir do projeto.

**Segfault por má seleção.** Há um `TODO: we segfault` vivo no `fillet` do CadQuery — selecionar arestas de um sólido que não é o do contexto derruba o interpretador. Na nossa fronteira N-API isso é inaceitável: **valide que toda entidade referenciada pertence ao body alvo antes de chamar o nativo.**

### O que o CadQuery *não* resolveu

Naming topológico, no caso geral. Como `__eq__` do CadQuery é identidade de ponteiro OCCT (`TShape`) e toda operação booleana regenera todos os `TShape`s, nenhuma referência a face sobrevive a uma operação — ela precisa ser re-derivada da geometria toda vez. Quando um parâmetro muda e a ordenação de faces muda junto, `>Z[-2]` seleciona outra face **sem erro**: o sólido resultante é válido e errado.

Esse é exatamente o problema que precisamos resolver melhor, e é o motivo de a seção abaixo vir antes de qualquer feature além de extrude.

### Identidade topológica

O calcanhar de Aquiles de qualquer CAD paramétrico. Regra: IDs **não** vêm do kernel. Nós derivamos um nome estável:
`featureId + papel semântico + índice determinístico` (ex.: `f7/extrude/side[3]`), com um resolvedor por proximidade geométrica como fallback quando a topologia muda. Isso precisa ser projetado antes de qualquer feature além de extrude.

## Fronteira N-API e marshaling

O kernel é um **addon nativo** carregado no processo do server, não WASM e não um processo separado. OCCT roda como biblioteca C++ nativa; o TS fala com ele via N-API.

### Regra de ouro: a fronteira é estreita e grossa

Estreita em *superfície* (poucas funções), grossa em *payload* (muito dado por chamada). Cada travessia TS↔nativo custa; um `for` em TS chamando o kernel por aresta é o anti-padrão que mata a performance.

- ❌ `for (e of edges) k.filletEdge(body, e, r)`
- ✅ `k.fillet(body, edges, radii)` — uma chamada, arrays inteiros

### Modelo de ownership

- Objetos OCCT **nunca** cruzam a fronteira. Ficam num registro do lado nativo (`Session` → `HashMap<BodyId, TopoDS_Shape>`).
- O TS só vê `BodyId` = inteiro opaco (`u32` num branded type).
- Liberação é **explícita** (`session.release(ids)`), atrelada ao ciclo de vida da sessão. Nada de depender de GC do V8 ou de finalizers para memória nativa — não é determinístico e OCCT segura muita RAM.
- Uma `Session` nativa por sessão de usuário. Isola vazamentos e permite descartar tudo de uma vez no TTL.

### Marshaling

Três classes de dado, três tratamentos:

| Dado | Formato | Por quê |
|---|---|---|
| Parâmetros de comando (números, enums, IDs) | objeto JS convertido campo a campo | pequeno, legibilidade ganha |
| Geometria de entrada (pontos de spline, listas de arestas) | `Float64Array` / `Uint32Array` (typed array) | zero-copy, sem alocação por elemento |
| Meshes de saída | **um buffer só**, `ArrayBuffer` com header + seções | maior payload do sistema; um `Buffer` grande é ordens de magnitude mais rápido que um array de objetos JS |

Layout de mesh (little-endian, packed):

```
header: u32 vertexCount, u32 triangleCount, u32 faceGroupCount
positions:  f32 * 3 * vertexCount
normals:    f32 * 3 * vertexCount
indices:    u32 * 3 * triangleCount
faceGroups: (u32 faceId, u32 triStart, u32 triCount) * faceGroupCount
```

Esse mesmo buffer vai **direto pro cliente pelo WS e direto pro GPU buffer**, sem re-serialização. É o motivo de escolher esse layout: um formato, três consumidores.

### Threading

Operações de kernel são pesadas (segundos, em casos ruins) e **bloqueiam**. Nunca rode na thread do event loop.

- Toda operação é um `AsyncTask` do N-API (`AsyncWorker` em C++ / `#[napi]` async em Rust) → roda na threadpool do libuv.
- OCCT **não é thread-safe** entre operações na mesma shape. Uma `Session` = um mutex; operações da mesma sessão serializam. Sessões diferentes rodam em paralelo.
- Ajustar `UV_THREADPOOL_SIZE` conforme o número de sessões concorrentes por instância EC2.

### Erros

OCCT sinaliza por exceção C++ (`Standard_Failure`) e às vezes por *crash*. Na fronteira:

- `try/catch` no lado nativo converte `Standard_Failure` → objeto de erro estruturado (`{code, message, entity?}`), retornado como valor. Nunca deixe exceção C++ escapar para o N-API — derruba o processo.
- Para as operações historicamente frágeis (fillet, boolean, loft), considere isolamento por subprocesso no futuro. Por ora: valide entradas agressivamente antes de chamar.

### Build

**OCCT vem pré-compilado. Nunca compilamos do fonte.** Compilar OCCT leva dezenas de minutos — inviável no `npm install` do dev e pior ainda no CI.

- **Conan** (`opencascade/7.8.1`), linkado **estático**. Escolhido sobre vcpkg e binários oficiais por ser o que melhor funciona em Linux/Docker: restaura binários prontos num comando e resolve as deps transitivas do OCCT (TBB, FreeType), que são a parte chata de linkar estático à mão.
- `--build=never` no `conan install`: falha alto em vez de cair silenciosamente num build do fonte. Um job de CI que compila OCCT sem avisar é um job que estoura o timeout.
- Perfil Conan **fixado** no repo. Sem isso, o Conan detecta a toolchain local e dois desenvolvedores acabam com pacotes de ABI diferente.
- No Dockerfile o restore vem **antes** de qualquer `COPY` de fonte: editar Rust não rebaixa a camada do OCCT.
- Módulos desnecessários desligados (`with_opengl=False` inclusive — o kernel tessela e devolve buffer; renderização é no browser).
- `napi-rs` (Rust) no lado nativo: `Result<T, E>` mapeia direto no nosso modelo de erro e é bem mais difícil derrubar o processo por acidente.
- Ordem de link importa: arquivos estáticos resolvem da esquerda para a direita, e `TKernel` fica por último. Fora de ordem, o erro parece "biblioteca faltando".

## Sessões

- Cliente abre sessão → recebe `sessionId` + TTL.
- Cada comando renova o TTL.
- Sessão detém: documento carregado, estado do kernel (bodies vivos), cache de mesh.
- Expirou → estado do kernel é descartado; reabrir replay do último commit git.
- Server é stateful mas **recuperável**: nada de valor vive só na memória.

## Git como banco

- Um repositório por documento.
- `document.json` (feature tree) + `meshes/` (cache opcional) + `refs/` .
- Commit por comando (squash opcional na UI).
- Branch = versão/variante. Merge = merge de feature tree (conflitos em nível de feature, não de texto).
- Dev: disco local. Prod: bare repo em S3 (via `isomorphic-git` + backend de objetos custom).

## Cliente

- **SolidJS** para o HUD/painéis: feature tree, toolbar, campos de parâmetro, seleção.
- Canvas 3D é imperativo (WebGL2/WebGPU), fora do reativo do Solid; sinais só publicam intenção.
- Seleção: picking por ID de face/aresta renderizado em render target auxiliar, resolvido para `FaceId`/`EdgeId`.

## Features (roadmap)

| Feature | Depende de |
|---|---|
| sketch + drafts | plano, curvas |
| extrude | sketch, boolean |
| revolve | sketch, eixo |
| loft | múltiplos perfis |
| sweep | perfil + path |
| mirror / pattern (linear, circular) | transform, boolean |
| fillet / chamfer | seleção de aresta estável |
| hole | face + posição + norma (ISO/ANSI) |
| bolts | biblioteca de peças + mate |
| draft (ângulo de saída) | face + direção de puxada |

## Convenções de geometria

- Unidades internas: **milímetros**, double. Ângulos em radianos.
- Sistema destro, Z para cima.
- Tolerância linear padrão: 1e-6 mm; angular 1e-9 rad.
- Nada de `any` na fronteira de pacotes. Erro de kernel vira `KernelResult<T>`, nunca exceção.
- Testes de geometria comparam invariantes (volume, área, contagem de faces), não bytes.
