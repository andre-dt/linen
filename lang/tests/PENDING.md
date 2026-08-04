# Erros que o compilador ainda aceita

Programas mal formados que hoje compilam sem reclamar. Cada um vira um
`reject-*.lang` no dia em que passar a ser pego.

Estão listados aqui em vez de escritos como testes porque um teste que
falha desde o primeiro dia acostuma todo mundo a ver vermelho — e a
suíte só vale enquanto verde significa são.

## O que já é pego

**Resolução** (`syntax/resolve.rs`) — chamar função inexistente,
argumento a mais, a menos, repetido, fora de ordem, campo obrigatório
omitido.

**Tipos** (`syntax/check.rs`) — nome nunca ligado, tipo inexistente,
condição não-booleana em `if`/`while`/`throw`, aritmética sobre `bool`,
`and`/`or` sobre número, igualdade entre número e bool, retorno do tipo
errado, `return` vazio com tipo declarado, valor de função que não
retorna nada, argumento do tipo errado.

## O que falta

| erro | exemplo |
|---|---|
| função declarada duas vezes | dois `fn f()` |
| binding declarado duas vezes no mesmo escopo | dois `let x` |
| `test` com nome repetido | dois `test "t"` |
| função sem `return` mas com tipo de retorno | `fn f() i32` com corpo sem return |
| default de tipo errado | `fn f(a i32 = true)` |
| `test` com nome repetido | dois `test "t"` |

## Erros de execução que já se reportam

`at(list:, index:)` fora do intervalo. Antes devolvia null e o código
gerado dereferenciava: um defeito duas camadas acima chegava como
segfault, sem nome de teste. Agora a leitura é registrada e o runner diz
qual teste leu onde — inclusive quando o teste "passaria", tendo lido um
zero que nunca esteve na lista.

Ainda não é erro de compilação, e não dá para ser: o índice é um valor
calculado.

Divisão por zero fica de fora de propósito: `1 / 0` é erro de execução,
não de tipo, e só tem resposta quando houver backend para executá-lo.
O mesmo vale para overflow no estreitamento de i64 para i32 — é uma
checagem de runtime, não de tipo.

## `#!` — o que o typechecker ainda não enxerga

**Nenhum arquivo.** A lista está vazia: tudo em `tests/` passa pelo
lexer, parser, resolução, tipos e backend, e roda.

`shape` e `array` saíram: `Type::Shape(i)` e `Type::Array(i)` indexam
tabelas do unit. No LLVM uma shape é **struct por valor** e um array
fixo é **array por valor** — sem ponteiro, sem alocação, porque o
tamanho está no tipo. Valor imutável não tem identidade, então não há o
que um ponteiro distinguisse.

`List<T>` **existe**: cresce, mora na arena, e é o que um polígono de
tamanho desconhecido precisa. `Type::List(i)` indexa a mesma tabela dos
arrays, distinguido por não ter tamanho.

Literal que não cabe **já é pego**: `f(n: 1000000000000)` para
`fn f(n i32)` é erro de compilação, porque os dois lados são conhecidos.
O que falta é o estreitamento de um valor *calculado* — aí só dá para
saber em runtime.

## Sem checagem de limites — em array

`xs[5]` num array de 3 lê fora. Em **lista** já se reporta (veja acima);
em array fixo ainda não, e é o mesmo mecanismo — falta ligá-lo.

O overflow do estreitamento de i64 para i32 entra no mesmo lugar.
