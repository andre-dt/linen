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
- **suíte** — 28 arquivos em `tests/`: 8 de linguagem (53 testes) e 20
  rejeições, uma por mensagem de erro distinta
- **CLI `linen`** — `build`/`test`/`clean`, erro com arquivo:linha:coluna
  e caret, relatório progressivo e sumário — 49 testes no total

Em aberto:
- **Encadeamento** — `.pipe(f)`, UFCS (`x.f()` = `f(x)`) ou `|>`. Não
  decidido; nada depende disso ainda.
- A sintaxe exata de `struct`, `for` e dos genéricos, que se firma
  escrevendo o parser.

Próximo: typechecker, depois o primeiro codegen LLVM. Um `test` que
compila até nativo e roda.

`struct` e `List` entram depois disso — a espinha (parser → tipos →
codegen) tem que estar de pé antes de crescer a linguagem.
