# A linguagem

Uma linguagem para escrever kernel geométrico: pura, sem GC, compilada
para nativo via LLVM.

O compilador é Rust + inkwell, e se usa por um comando só:

    linen build [file]     compila
    linen test  [path]     compila e roda os testes
    linen clean            joga fora o que foi construído

Sem path, o diretório é achado **subindo** a partir de onde você está —
como o `git` acha o `.git` — então o comando funciona de qualquer lugar
dentro do projeto.

De fora, `LINEN_HOME` aponta a raiz do repositório:

    export LINEN_HOME=~/dt/linen

Aceita tanto a raiz (`<home>/lang/tests`) quanto o próprio `lang/`
(`<home>/tests`), para a variável não ficar certa numa forma e
misteriosamente vazia na outra.

Um binário com subcomandos, como o `zig`, em vez de compilador + driver +
runner. Os três dividem o mesmo front end, e discordarem sobre como
acham arquivo ou reportam erro é bug que o binário único não pode ter.

    texto → lexer → parser → AST → LLVM IR → nativo

Três crates, divididos na única costura que importa — LLVM:

- `crates/syntax` vai do texto à AST e não sabe que backend existe
- `crates/compile` é o único que linka LLVM, e onde mora a ABI
- `crates/cli` é o binário

## ABI por host

O backend gera para um *host*: um triple mais as convenções que vêm com
ele. Hoje um só, `x86_64-unknown-linux-gnu` (System V).

Está num `enum`, não numa string, de propósito: host novo é uma variante,
e o compilador não builda até todo `match` ter um braço para ela. Uma
string deixaria `if triple.contains("windows")` nascer espalhado pelo
backend.

`--target` aceita o triple inteiro e o apelido curto; alvo desconhecido
lista os que existem, porque "unknown target" sozinho deixa o usuário
adivinhando a grafia.

## As três decisões que definem tudo

### Imutabilidade total, mutação escondida

Não existe `mut`. Não existe atribuição. Um valor novo, sempre — na
**semântica**.

Na implementação, o compilador muta à vontade, desde que prove que
ninguém pode notar. É a distinção que resolve o falso dilema entre "puro
mas lento" e "rápido mas com aliasing":

```
let a = [1, 2, 3]
let b = a.set(0, 99)
```

Se `a` não é lido depois dessa linha, ele está morto — e copiar um array
para escrever por cima do cadáver é desperdício que nenhum observador
pode distinguir de escrever direto. O compilador escreve in-place e `b` é
o mesmo ponteiro.

A prova é **liveness**: a última leitura de um valor é onde ele pode ser
canibalizado. É análise que todo compilador já faz para alocar
registradores, e aqui ela ganha um segundo uso.

Isso não é experimental — é o *Perceus* de Koka, a *opportunistic
mutation* de Roc, os *uniqueness types* de Futhark. O que muda entre eles
é o quanto o usuário precisa saber; aqui, nada.

**Por que funciona especialmente bem neste caso:** um pipeline linear é
justamente onde a análise nunca erra. Em
`ctx.pipe(validate).pipe(allocate)`, cada estágio é o único dono do que
recebe e o anterior morre ali — então toda alocação intermediária some. E
em SoA, o que some é o `memcpy` de buffers que são o grosso da memória de
um kernel.

**O custo, dito com honestidade:** quando a análise falha, você copia sem
saber, e a performance vira difícil de prever. Futhark resolve deixando o
usuário *exigir* in-place pelo tipo; Roc, com um profiler que aponta as
cópias. Não decidido aqui — e não precisa ser, porque isto é
**otimização, não semântica**: a linguagem funciona copiando, e a análise
entra depois sem mudar uma linha de código de usuário.

A regra de partida é conservadora: reusa quando o argumento é o único
dono e morre na chamada; copia em qualquer dúvida.

### Arena por chamada

Tudo que uma operação aloca sai de uma arena; a arena inteira é liberada
quando a operação termina. Sem GC, sem `free`, sem ownership no código do
usuário.

Casa com a imutabilidade: sem mutação observável não há ciclo nem dono
compartilhado a rastrear, então liberar tudo de uma vez no fim é
suficiente — não há caso em que algo precise morrer antes. E casa com o padrão de uso de um kernel, onde uma
operação geométrica é uma transação com começo e fim claros.

Consequência: **nada sobrevive à chamada que o alocou**. Um resultado que
precisa durar é copiado para fora, explicitamente.

### Genéricos monomorfizados

`fn map<T, U>` é escrevível pelo usuário. Cada instanciação vira código
especializado no LLVM, como em Rust e C++: abstração sem custo em runtime.

É a decisão mais cara das três para o compilador — exige inferência e uma
passada de monomorfização antes do codegen — e é a que torna possível
escrever as partes genéricas de um kernel (buffers, listas, pipelines)
uma vez só.

## Números: inteiro, e só

Não existe ponto flutuante. Geometria é aritmética **inteira**, pelo
mesmo motivo que sistema financeiro conta centavos: o erro de
arredondamento não é pequeno, é *acumulativo*, e num kernel BREP ele não
produz um número um pouco errado — produz um sólido inconsistente, onde
um ponto está dentro num teste e fora no seguinte.

A unidade é o **micron**. A faixa é 1 micron a 10 metros, o que dá 10⁷
unidades.

### Armazena em 32, calcula em 64

    coordenada guardada    i32     12 bytes por ponto 3D
    toda conta             i64     folga de 10¹² sobre a faixa
    predicados             i128    orient3d é produto triplo

Os três tamanhos existem porque cada um resolve uma coisa diferente:

**i32 no armazenamento** porque uma malha tem milhões de vértices e o que
manda ali é quantos pontos cabem numa linha de cache — 5 em vez de 2,6.
A faixa cabe: 10⁷ dos 2,1·10⁹ disponíveis.

**i64 no cálculo** porque a folga do i32 é de só 215×, e geometria estoura
por caminhos indiretos — um `pattern` que repete uma peça a 10 m da
origem, uma soma `a + b` antes de dividir para achar um ponto médio.
Alargar é uma instrução; com i64 esses casos simplesmente não existem.

**i128 nos predicados** porque `orient3d` — "este ponto está acima ou
abaixo deste plano?", o predicado mais usado de um kernel BREP — é um
determinante 3×3, soma de seis produtos triplos. Produto triplo de
coordenadas dá 10²¹, que **não cabe em i64**. Em i128 cabe com folga de
10¹⁶, e `insphere` (produto de quatro) também.

Guardar em i32 e calcular em i64 é o que dá as duas coisas: memória de
32 e aritmética folgada. A fronteira é explícita — valor que não cabe em
i32 na hora de guardar é erro, nunca um número que deu a volta em
silêncio.

### O que isso compra

- **`orient3d` vira exato.** Sem épsilon, sem "quase coplanar": o sinal
  do determinante é *o* sinal, não uma estimativa. Em `double` esse
  predicado é a origem clássica de BREP inconsistente.
- **Igualdade é igualdade.** Comparar coordenada é comparar inteiro, e
  `LINEAR_TOLERANCE` sai do vocabulário.
- **Determinismo entre máquinas.** O requisito de "mesma feature tree ⇒
  mesma geometria e mesmos IDs" é dado de graça pelo inteiro. `double`
  não dá: `fma` e reassociação mudam o último bit conforme o alvo.

### O que isso não resolve

Ser honesto sobre a parte difícil, porque ela chega junto com a primeira
interseção:

**Interseção não é fechada nos inteiros.** Duas retas de extremos
inteiros se cruzam num ponto **racional**, quase nunca inteiro. Ou se
arredonda para a grade (*snap rounding* — simples, mas mover um ponto
pode criar interseção nova), ou se guarda o racional exato e arredonda só
na tesselação (exato, mas o denominador cresce a cada operação
encadeada). Não decidido; chega com `boolean`.

**Curvas não têm ponto racional.** Círculo, revolve, NURBS: `sqrt` e
`cos` saem da aritmética exata. O desenho provável é geometria planar
exata em inteiro, curvas aproximadas na grade com erro limitado a 1
micron.

## Sintaxe

Sem chaves, sem `;`, sem `:`, sem `->`. Blocos por indentação, com
espaços; tab é erro. `#` comenta até o fim da linha.

O tipo vem depois do nome: `depth i32`.

```
fn double(n i32) i32
  return n * 2

test "doubling"
  assert(double(21) == 42)
```

### Condicionais, nos dois papéis

`if` existe como **statement** e como **expressão**, e a diferença é uma
só: a expressão exige `else`, porque tem que ter valor dos dois lados.

```
fn sign(n i32) i32          # statement: else é opcional
  if n < 0
    return -1
  return 1

fn abs(n i32) i32           # expressão: uma linha, else obrigatório
  return if n < 0 then -n else n
```

A forma de expressão cabe **numa linha** de propósito. Uma expressão pode
aparecer no meio da linha — dentro de um argumento, à direita de um `let`
— e abrir bloco indentado ali poria a regra de layout em conflito consigo
mesma. `then` separa a condição do valor; sem ele, `if a - 1 else` teria
que adivinhar onde a condição termina.

### Dados: shape, array, List

`shape` é a forma de um valor. Não é `struct` nem `class` porque não tem
método, herança nem comportamento — só campos.

```
shape Point
  x i32
  y i32

let p = Point(x: 1, y: 2)
let a = p.x
```

### O case é gramática

**PascalCase nomeia shape, snake_case nomeia função.** Não é convenção —
o compilador exige, e é o que deixa `Point(x: 1)` e `add(a: 1)` serem
distinguidos no primeiro token, sem olhar adiante.

    shape Point   ✓        fn add     ✓
    shape point   ✗        fn Add     ✗

### Tudo que entra é nomeado

Chamada e construção se escrevem igual: cada argumento traz o nome do
parâmetro ou do campo.

```
let p = Point(x: 1, y: 2)
let s = add(a: 20, b: 22)
```

Posicional seria mais curto, mas dois parâmetros do mesmo tipo poderiam
ser trocados sem ninguém notar, e o leitor teria que ir buscar a
assinatura para saber o que o segundo `10` significa. Campo novo também
quebraria toda construção silenciosamente em vez de ruidosamente.

### Na ordem, e nada é opcional por acaso

Os argumentos vêm na ordem em que foram declarados. `add(b: 2, a: 1)` é
erro — não por rigor, mas porque seriam duas formas de escrever a mesma
chamada, e o leitor que confere uma chamada contra a assinatura teria que
checar qual das duas está lendo, toda vez.

Um parâmetro fica **opcional** ganhando um valor padrão. Só isso; não há
marcador separado, então não há um segundo lugar para manter em sincronia
com o padrão.

```
fn step(from i32, by i32 = 1) i32
  return from + by

step(from: 10)          # by vale 1
step(from: 10, by: 5)   # by vale 5
```

Os obrigatórios vêm antes dos opcionais — checado na **declaração**, não
na chamada. Como os argumentos correm em ordem, um obrigatório depois de
um opcional só seria alcançável deixando um buraco, e não existe notação
para buraco. Errar isso na declaração é um erro; deixar passar seria
espalhar o erro por toda chamada que não dá para escrever.

E é por aí que a linguagem **não tem null**: todo parâmetro ou é dado
pelo chamador ou tem padrão, e todo `let` nasce com valor. Nunca existe
um lugar onde falta valor, então nunca é preciso um valor para dizer
"falta".

Array e List são coisas diferentes, e a diferença é onde o valor mora:

```
[i32; 3]      tamanho no TIPO, sem alocação
List<i32>     cresce, mora na arena
```

O tamanho do array ser parte do tipo é o que deixa o valor existir sem
alocar nada.

### Iteração

`while` e `for`, os dois statements. O range do `for` é **meio-aberto**:
`0 .. 3` visita 0, 1 e 2 — assim `0 .. n` quer dizer "n vezes", e dois
ranges adjacentes se encontram sem se sobrepor.

```
for i in 0 .. 3
  throw "the range should stop before 3" unless i < 3
```

Recursão também funciona, e é a forma que sobra quando não há o que
mutar.

## A regra de trabalho: `.lang` primeiro

Toda mudança de código funcional começa por um `.lang` novo que **falha**.
O arquivo é escrito antes, roda vermelho, e só então o compilador muda
para fazê-lo passar.

Não é cerimônia — é a única forma de saber que o teste testa alguma
coisa. Um teste escrito depois passa por construção, e já aconteceu aqui:
81 testes continuaram verdes com o alargamento de tipos **removido de
propósito**, porque nenhum deles observava o que dizia observar.

O ciclo, então:

1. escreve o `.lang` que descreve o comportamento
2. roda e confirma que falha, **pelo motivo certo**
3. muda o compilador
4. roda e confirma que passa

O passo 2 é o que vale. Sem ele o resto é decoração.

## Como se sabe que o compilador está são

`cargo test`. Verde é são; qualquer coisa a menos não é.

A suíte tem duas metades, e a segunda é a que importa:

- **`crates/*/src/*_test.rs`** — testes de peça, em Rust. Que o lexer
  emite um Dedent, que `-` associa à esquerda.
- **`tests/*.lang`** — programas escritos NA linguagem, entrando pela
  mesma porta que um usuário. Um diretório plano; o que cada arquivo
  espera está escrito nele:

      sem `#~`   tem que compilar
      `#~ ...`   tem que ser rejeitado, com essa mensagem

Plano porque a expectativa é do arquivo. Um `pass/` e `fail/` diria a
mesma coisa duas vezes — no caminho e no conteúdo — e dois lugares para
dizer algo é um lugar para errar.

O harness que roda os `.lang` é um `#[test]` do cargo, não um script ao
lado — de propósito. Suíte que não trava o build é suíte que apodrece.

Checar só que falhou deixaria passar mensagem errada — e numa falha de
compilação a mensagem *é* o produto, então mensagem ruim é bug.

Os arquivos são descobertos, não listados: uma lista seria um segundo
lugar para lembrar, e pior que teste faltando é teste que ninguém
percebeu que nunca rodou.

## Estado

Feito:
- **lexer** com indentação semântica — 17 testes
- **parser** — `fn`, `test`, `let`, `return`, `assert`, expressões com
  precedência — 18 testes
- **bool** — `true`/`false`, `and`/`or`/`not`, `bool` como tipo
- **`if`** — statement e expressão
- **`while`**, **`for`** com range meio-aberto, e recursão
- **`shape`** com campos, aninhamento e acesso `.`
- **nomeação obrigatória** em chamada e construção, e o **case como
  gramática** (PascalCase = shape, snake_case = função)
- **parâmetros opcionais** por valor padrão, obrigatórios primeiro
- **resolução** (`syntax/resolve.rs`) — casa argumento com o que ele
  preenche: nomeado, na ordem declarada, e nada obrigatório faltando
- **tipos** (`syntax/check.rs`) — i32/i64/i128/bool, com a regra de
  alargamento: guarda em 32, calcula em 64
- **primeiro código de kernel** — `orient2d` exato em
  `tests/kernel-orientation.lang`
- **backend LLVM** (`compile/emit.rs`) — inteiros, chamadas, `if`,
  `while`, `for`, curto-circuito, `throw`; os testes **rodam** por JIT
- **shape completo** — tipo, construção e acesso a campo, checados e
  compilados; no LLVM é **struct por valor**, sem alocação
- **array fixo** — `[T; N]`, literal e índice, checados e compilados;
  no LLVM é **array por valor**, sem alocação
- **`Point` e polígono do kernel** — `orient2d`, `distance_squared`,
  área e winding exatos em `tests/kernel-point.lang` e
  `tests/kernel-polygon.lang`
- **`orient3d` em i128** — o determinante 3x3 chega a 10²¹; há um teste
  que passa em i128 e **falha em i64**, com o sinal invertido
- **`export fn` + objeto** — `linen build` emite `.o` e `liblinen.a`; só
  o exportado vira símbolo global, o resto o LLVM pode inlinar
- **addon N-API** (`apps/kernel/native`) — Node chama o kernel
- **array** `[i32; 3]` e **`List<T>`**, com índice
- **genéricos** — `shape Pair<T>`, `fn identity<T>` (sintaxe; a
  verificação chega com o typechecker)
- **suíte** — 84 arquivos em `tests/`: 21 de linguagem (163 testes) e 63
  rejeições, uma por mensagem de erro distinta
- **CLI `linen`** — `build`/`test`/`clean`, erro com arquivo:linha:coluna
  e caret, relatório progressivo e sumário — 94 testes no total

Em aberto:
- **Encadeamento** — `.pipe(f)`, UFCS (`x.f()` = `f(x)`) ou `|>`. Não
  decidido; nada depende disso ainda.
- A sintaxe exata de `struct`, `for` e dos genéricos, que se firma
  escrevendo o parser.

Próximo: typechecker, depois o primeiro codegen LLVM. Um `test` que
compila até nativo e roda.

`struct` e `List` entram depois disso — a espinha (parser → tipos →
codegen) tem que estar de pé antes de crescer a linguagem.
