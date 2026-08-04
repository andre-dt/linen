// =====================================================================
// compile/emit.rs — THE TREE INTO LLVM IR.
//
// The last stage: an AST that has been parsed, resolved and typechecked
// becomes instructions. Everything before this decided whether the
// program is legal; this decides what it DOES.
//
// WHAT A TEST COMPILES INTO
// -------------------------
// Each `test` becomes a function returning i32: 0 if it held, otherwise
// the 1-based index of the `throw` that fired. The index is the whole
// design — the runner needs to say WHICH assertion failed, and returning
// a number costs one register where returning a string would need an
// allocator this language does not have yet at test time.
//
// So `throw` is not a call and needs no unwinding: it is a `ret`. That
// is the payoff of the decision that a throw is always fatal — the
// feature costs nothing until it fires, and nothing at all when it does
// not.
//
// TYPES ARE ALREADY DECIDED
// -------------------------
// check.rs settled every type before this runs, and it applied the
// widening rule: i32 storage, i64 arithmetic. Here that shows up as
// explicit sign extension at each operand, because LLVM will not add an
// i32 to an i64 and should not.
//
// Sign extension, never zero extension: coordinates are signed and a
// negative one that widened as unsigned would become an enormous
// positive, which is precisely the silent wrongness the integer model
// exists to remove.
// =====================================================================

use std::collections::HashMap;

use inkwell::builder::Builder;
use inkwell::context::Context;
use inkwell::module::Module;
use inkwell::types::BasicType;
use inkwell::values::{BasicValueEnum, FunctionValue, IntValue};
use inkwell::IntPredicate;

use syntax::ast::*;
use syntax::check::{arrays_of, literal_type, resolve_written, type_of, Arrays, Type};

#[derive(Debug)]
pub struct EmitError {
    pub message: String,
}

/// One compiled unit, plus what the runner needs to drive it.
pub struct Compiled<'context> {
    pub module: Module<'context>,
    /// The tests, in source order, paired with the symbol to call.
    pub tests: Vec<CompiledTest>,
}

pub struct CompiledTest {
    pub name: String,
    pub symbol: String,
    /// The message of each `throw`, indexed by what the test returns —
    /// entry 0 is the throw that returns 1. Kept on this side rather
    /// than in the compiled code so the message never has to be a string
    /// in a language without an allocator.
    pub messages: Vec<String>,
}

pub fn emit<'context>(
    context: &'context Context,
    unit: &Unit,
    module_name: &str,
) -> Result<Compiled<'context>, EmitError> {
    let module = context.create_module(module_name);
    let builder = context.create_builder();

    let mut emitter = Emitter {
        context,
        module: &module,
        builder: &builder,
        functions: HashMap::new(),
        shapes: unit
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Shape(shape) => Some(shape),
                _ => None,
            })
            .collect(),
        arrays: arrays_of(unit).map_err(|error| EmitError {
            message: error.message,
        })?,
        unit,
    };

    // Declare every function before emitting any body, so a call to one
    // declared later still finds it. Two passes rather than sorting: the
    // language has no ordering rule and should not grow one.
    for item in &unit.items {
        if let Item::Function(function) = item {
            emitter.declare(function)?;
        }
    }

    for item in &unit.items {
        if let Item::Function(function) = item {
            emitter.function_body(function)?;
        }
    }

    let mut tests = Vec::new();
    for (index, item) in unit.items.iter().enumerate() {
        if let Item::Test(test) = item {
            tests.push(emitter.test(test, index)?);
        }
    }

    Ok(Compiled { module, tests })
}

struct Emitter<'a, 'context> {
    context: &'context Context,
    module: &'a Module<'context>,
    builder: &'a Builder<'context>,
    functions: HashMap<String, FunctionValue<'context>>,
    /// The shapes in source order. `Type::Shape(i)` indexes this — the
    /// same order the checker used, read from the same AST.
    shapes: Vec<&'a Shape>,
    /// The array table the checker built. Handed over rather than
    /// rebuilt: `Type::Array(i)` indexes it, and two tables built
    /// separately could disagree about which `i` is which.
    arrays: Arrays,
    unit: &'a Unit,
}

/// What is in scope while emitting a body: the name, its type as the
/// checker decided, and the value holding it.
///
/// A stack searched from the back, so a later binding shadows an earlier
/// one — the same rule the checker used, and it has to stay the same or
/// the two would disagree about which `x` a name means.
type Scope<'context> = Vec<(String, Type, BasicValueEnum<'context>)>;

impl<'a, 'context> Emitter<'a, 'context> {
    /// The integer type behind a primitive. Only valid for primitives —
    /// a shape has no integer form, and asking for one is a bug in the
    /// caller rather than something to represent.
    fn integer(&self, of: Type) -> inkwell::types::IntType<'context> {
        match of {
            Type::I32 => self.context.i32_type(),
            Type::I64 => self.context.i64_type(),
            Type::I128 => self.context.i128_type(),
            Type::Bool => self.context.bool_type(),
            Type::Shape(_) | Type::Array(_) => {
                unreachable!("a shape or array is not an integer; use `basic`")
            }
        }
    }

    /// Any type, as LLVM sees it.
    ///
    /// A shape becomes a STRUCT VALUE, not a pointer to one. Values in
    /// this language are immutable and have no identity — two points
    /// with the same coordinates are the same point — so there is
    /// nothing for a pointer to distinguish, and passing by value lets
    /// LLVM keep small shapes in registers instead of touching memory.
    ///
    /// It also means shapes need no allocation at all, which is what
    /// keeps them usable before there is an arena.
    fn basic(&self, of: Type) -> Result<inkwell::types::BasicTypeEnum<'context>, EmitError> {
        Ok(match of {
            Type::Shape(index) => self.shape_type(index)?.into(),
            // A fixed array is an LLVM array: the size is in the type,
            // so the value carries its own space and needs no
            // allocation — the same reason a shape is a struct value.
            Type::Array(entry) => {
                let info = self.arrays.get(entry).ok_or_else(|| EmitError {
                    message: "an array type outside the unit".to_string(),
                })?;
                self.basic(info.element)?.array_type(info.size as u32).into()
            }
            primitive => self.integer(primitive).into(),
        })
    }

    /// The struct type for a shape, built from its declared fields in
    /// order. Field access is by position, which is why the checker and
    /// this must agree on that order — they both read it from the AST.
    fn shape_type(&self, index: usize) -> Result<inkwell::types::StructType<'context>, EmitError> {
        let shape = self
            .shapes
            .get(index)
            .ok_or_else(|| EmitError {
                message: "a shape index outside the unit".to_string(),
            })?;
        let fields: Vec<_> = shape
            .fields
            .iter()
            .map(|field| {
                let of = self.type_of_name(&field.type_name)?;
                self.basic(of)
            })
            .collect::<Result<Vec<_>, EmitError>>()?;
        Ok(self.context.struct_type(&fields, false))
    }

    fn declare(&mut self, function: &Function) -> Result<(), EmitError> {
        let parameters: Vec<_> = function
            .parameters
            .iter()
            .map(|parameter| {
                let of = self.type_of_name(&parameter.type_name)?;
                Ok(self.basic(of)?.into())
            })
            .collect::<Result<Vec<_>, EmitError>>()?;

        let signature = match &function.result {
            Some(result) => {
                let of = self.type_of_name(result)?;
                self.basic(of)?.fn_type(&parameters, false)
            }
            None => self.context.void_type().fn_type(&parameters, false),
        };

        let value = self.module.add_function(&function.name, signature, None);
        self.functions.insert(function.name.clone(), value);
        Ok(())
    }

    /// A written type, resolved by the CHECKER's rule.
    ///
    /// Delegated rather than reimplemented. The backend once had its own
    /// copy, and the copy forgot arrays — so `[i32; 3]` fell through to
    /// the shape lookup and failed as "only an array can be indexed",
    /// which named the symptom two steps downstream of the cause.
    fn type_of_name(&self, type_name: &TypeName) -> Result<Type, EmitError> {
        resolve_written(self.unit, type_name, &self.arrays).map_err(|error| EmitError {
            message: error.message,
        })
    }

    fn function_body(&mut self, function: &Function) -> Result<(), EmitError> {
        let value = self.functions[&function.name];
        let entry = self.context.append_basic_block(value, "entry");
        self.builder.position_at_end(entry);

        let mut scope: Scope = Vec::new();
        for (index, parameter) in function.parameters.iter().enumerate() {
            let of = self.type_of_name(&parameter.type_name)?;
            let argument = value
                .get_nth_param(index as u32)
                .expect("declared with this many parameters");
            scope.push((parameter.name.clone(), of, argument));
        }

        let result = match &function.result {
            Some(result) => Some(self.type_of_name(result)?),
            None => None,
        };

        self.body(&function.body, &mut scope, &mut Vec::new(), result)?;

        // A body that ran off the end without returning. The checker
        // does not require a return on every path yet, so this keeps the
        // IR well formed instead of leaving a block with no terminator.
        if self
            .builder
            .get_insert_block()
            .is_some_and(|block| block.get_terminator().is_none())
        {
            match result {
                Some(of) => {
                    let zero = self.integer(of).const_zero();
                    self.builder.build_return(Some(&zero)).map_err(builder_error)?;
                }
                None => {
                    self.builder.build_return(None).map_err(builder_error)?;
                }
            }
        }
        Ok(())
    }

    /// A test becomes `fn() -> i32`: 0 for held, else which throw fired.
    fn test(&mut self, test: &Test, index: usize) -> Result<CompiledTest, EmitError> {
        // The symbol carries the index, not the name: two tests may share
        // a name, and a name may hold anything a quoted string can.
        let symbol = format!("linen.test.{index}");
        let signature = self.context.i32_type().fn_type(&[], false);
        let value = self.module.add_function(&symbol, signature, None);
        let entry = self.context.append_basic_block(value, "entry");
        self.builder.position_at_end(entry);

        let mut scope: Scope = Vec::new();
        let mut messages = Vec::new();
        self.body(&test.body, &mut scope, &mut messages, None)?;

        // Fell through every throw, so it held.
        if self
            .builder
            .get_insert_block()
            .is_some_and(|block| block.get_terminator().is_none())
        {
            let zero = self.context.i32_type().const_zero();
            self.builder.build_return(Some(&zero)).map_err(builder_error)?;
        }

        Ok(CompiledTest {
            name: test.name.clone(),
            symbol,
            messages,
        })
    }

    // --- statements -------------------------------------------------------

    fn body(
        &mut self,
        statements: &[Statement],
        scope: &mut Scope<'context>,
        messages: &mut Vec<String>,
        result: Option<Type>,
    ) -> Result<(), EmitError> {
        let depth = scope.len();
        for statement in statements {
            self.statement(statement, scope, messages, result)?;
        }
        scope.truncate(depth);
        Ok(())
    }

    fn statement(
        &mut self,
        statement: &Statement,
        scope: &mut Scope<'context>,
        messages: &mut Vec<String>,
        result: Option<Type>,
    ) -> Result<(), EmitError> {
        match statement {
            Statement::Let { name, value, .. } => {
                let of = self.checked_type(value, scope)?;
                let emitted = self.expression(value, scope)?;
                scope.push((name.clone(), of, emitted));
            }

            Statement::Return { value, .. } => match value {
                Some(value) => {
                    let emitted = self.expression(value, scope)?;
                    let of = self.checked_type(value, scope)?;
                    // The declared type wins: `fn mid(...) i32` with an
                    // i64 body narrows here, which the checker allowed
                    // and which is how a computed value gets stored back.
                    let converted = match result {
                        Some(wanted) => self.convert_any(emitted, of, wanted)?,
                        None => emitted,
                    };
                    self.builder.build_return(Some(&converted)).map_err(builder_error)?;
                }
                None => {
                    self.builder.build_return(None).map_err(builder_error)?;
                }
            },

            Statement::If { condition, then_branch, else_branch, .. } => {
                let function = self.current_function();
                let test = self.integer_expression(condition, scope)?;

                let then_block = self.context.append_basic_block(function, "then");
                let else_block = self.context.append_basic_block(function, "else");
                let after = self.context.append_basic_block(function, "after");

                self.builder
                    .build_conditional_branch(test, then_block, else_block)
                    .map_err(builder_error)?;

                self.builder.position_at_end(then_block);
                self.body(then_branch, scope, messages, result)?;
                self.branch_to(after)?;

                self.builder.position_at_end(else_block);
                if let Some(else_branch) = else_branch {
                    self.body(else_branch, scope, messages, result)?;
                }
                self.branch_to(after)?;

                self.builder.position_at_end(after);
            }

            Statement::While { condition, body, .. } => {
                let function = self.current_function();
                let head = self.context.append_basic_block(function, "while");
                let inside = self.context.append_basic_block(function, "do");
                let after = self.context.append_basic_block(function, "done");

                self.builder.build_unconditional_branch(head).map_err(builder_error)?;

                self.builder.position_at_end(head);
                let test = self.integer_expression(condition, scope)?;
                self.builder
                    .build_conditional_branch(test, inside, after)
                    .map_err(builder_error)?;

                self.builder.position_at_end(inside);
                self.body(body, scope, messages, result)?;
                self.branch_to(head)?;

                self.builder.position_at_end(after);
            }

            // `for i in start .. end` — half-open, so `0 .. n` runs n
            // times. The counter is a phi rather than a mutable slot:
            // the language has no assignment, and SSA is what that looks
            // like in IR.
            Statement::For { name, start, end, body, .. } => {
                let function = self.current_function();
                let of = self.checked_type(start, scope)?;
                let counter_type = self.integer(of);

                let from = self.integer_expression(start, scope)?;
                let from = self.convert(from, self.checked_type(start, scope)?, of)?;
                let to = self.integer_expression(end, scope)?;
                let to = self.convert(to, self.checked_type(end, scope)?, of)?;

                let head = self.context.append_basic_block(function, "for");
                let inside = self.context.append_basic_block(function, "do");
                let after = self.context.append_basic_block(function, "done");

                let entry = self.builder.get_insert_block().expect("inside a block");
                self.builder.build_unconditional_branch(head).map_err(builder_error)?;

                self.builder.position_at_end(head);
                let counter = self.builder.build_phi(counter_type, name).map_err(builder_error)?;
                counter.add_incoming(&[(&from, entry)]);
                let current = counter.as_basic_value().into_int_value();

                let more = self
                    .builder
                    .build_int_compare(IntPredicate::SLT, current, to, "more")
                    .map_err(builder_error)?;
                self.builder
                    .build_conditional_branch(more, inside, after)
                    .map_err(builder_error)?;

                self.builder.position_at_end(inside);
                let depth = scope.len();
                scope.push((name.clone(), of, current.into()));
                self.body(body, scope, messages, result)?;
                scope.truncate(depth);

                let one = counter_type.const_int(1, false);
                let next = self.builder.build_int_add(current, one, "next").map_err(builder_error)?;
                let latch = self.builder.get_insert_block().expect("inside a block");
                if latch.get_terminator().is_none() {
                    self.builder.build_unconditional_branch(head).map_err(builder_error)?;
                    counter.add_incoming(&[(&next, latch)]);
                }

                self.builder.position_at_end(after);
            }

            // The one that makes a test a test. `if` throws when the
            // condition holds; `unless` throws when it does not.
            Statement::Throw { message, sense, condition, .. } => {
                let function = self.current_function();
                let test = self.integer_expression(condition, scope)?;
                let fires = match sense {
                    ThrowSense::When => test,
                    ThrowSense::Unless => self.builder.build_not(test, "held").map_err(builder_error)?,
                };

                messages.push(message.clone());
                let which = messages.len() as u64;

                let thrown = self.context.append_basic_block(function, "thrown");
                let continued = self.context.append_basic_block(function, "held");
                self.builder
                    .build_conditional_branch(fires, thrown, continued)
                    .map_err(builder_error)?;

                // A throw is a `ret`, not a call: it is always fatal, so
                // there is nothing to unwind and no landing pad.
                self.builder.position_at_end(thrown);
                let index = self.context.i32_type().const_int(which, false);
                self.builder.build_return(Some(&index)).map_err(builder_error)?;

                self.builder.position_at_end(continued);
            }
        }
        Ok(())
    }

    /// Branches to `target` unless the current block already ended — a
    /// body finishing in `return` leaves a terminator, and adding a
    /// second one is invalid IR.
    fn branch_to(&self, target: inkwell::basic_block::BasicBlock<'context>) -> Result<(), EmitError> {
        if self
            .builder
            .get_insert_block()
            .is_some_and(|block| block.get_terminator().is_none())
        {
            self.builder.build_unconditional_branch(target).map_err(builder_error)?;
        }
        Ok(())
    }

    fn current_function(&self) -> FunctionValue<'context> {
        self.builder
            .get_insert_block()
            .expect("inside a block")
            .get_parent()
            .expect("a block belongs to a function")
    }

    // --- expressions ------------------------------------------------------

    /// The type the checker gave this expression. Asked rather than
    /// re-derived, so codegen and the checker cannot drift apart about
    /// what widened where.
    fn checked_type(
        &self,
        expression: &Expression,
        scope: &Scope<'context>,
    ) -> Result<Type, EmitError> {
        let bindings: Vec<(String, Type)> = scope
            .iter()
            .map(|(name, of, _)| (name.clone(), *of))
            .collect();
        type_of(self.unit, expression, &bindings, &self.arrays).map_err(|error| EmitError {
            message: error.message,
        })
    }

    /// Sign extension or truncation between integer widths.
    ///
    /// Signed, always: a negative coordinate widened as unsigned would
    /// become an enormous positive, which is the silent wrongness the
    /// integer model exists to remove.
    fn convert(
        &self,
        value: IntValue<'context>,
        from: Type,
        to: Type,
    ) -> Result<IntValue<'context>, EmitError> {
        if from == to {
            return Ok(value);
        }
        let target = self.integer(to);
        // Truncation is where a value can be lost. The checker allows it
        // — storing a computed i64 back into an i32 coordinate is the
        // point — and a runtime check belongs here, once there is a way
        // to report one. Until then it wraps, which is recorded in
        // PENDING.md rather than left to be discovered.
        let converted = self
            .builder
            .build_int_cast_sign_flag(value, target, true, "widen")
            .map_err(builder_error)?;
        Ok(converted)
    }

    /// An expression that must produce an integer — every arithmetic
    /// and comparison path. A shape reaching one of those is a checker
    /// bug, not something to represent.
    fn integer_expression(
        &mut self,
        expression: &Expression,
        scope: &Scope<'context>,
    ) -> Result<IntValue<'context>, EmitError> {
        match self.expression(expression, scope)? {
            BasicValueEnum::IntValue(value) => Ok(value),
            other => Err(EmitError {
                message: format!("expected a number here, found {other:?}"),
            }),
        }
    }

    /// `convert`, for a value that may be a shape.
    ///
    /// Shapes never convert: two different shapes are different types
    /// and the checker rejected the mismatch, so the only thing to do
    /// with one is pass it along.
    fn convert_any(
        &self,
        value: BasicValueEnum<'context>,
        from: Type,
        to: Type,
    ) -> Result<BasicValueEnum<'context>, EmitError> {
        match value {
            BasicValueEnum::IntValue(integer) => {
                Ok(self.convert(integer, from, to)?.into())
            }
            other => Ok(other),
        }
    }

    fn expression(
        &mut self,
        expression: &Expression,
        scope: &Scope<'context>,
    ) -> Result<BasicValueEnum<'context>, EmitError> {
        match expression {
            Expression::Integer { value, .. } => {
                // The same narrowest-that-holds-it rule the checker used.
                // Emitting every literal as i32 would truncate the ones
                // that do not fit — a determinant written out in a test
                // is exactly such a literal.
                Ok(self
                    .integer(literal_type(*value))
                    .const_int(*value as u64, true)
                    .into())
            }

            Expression::Boolean { value, .. } => {
                Ok(self.context.bool_type().const_int(*value as u64, false).into())
            }

            Expression::Name { name, .. } => scope
                .iter()
                .rev()
                .find(|(bound, _, _)| bound == name)
                .map(|(_, _, value)| *value)
                .ok_or_else(|| EmitError {
                    message: format!("there is nothing called `{name}` here"),
                }),

            Expression::Unary { operator, operand, .. } => {
                let value = self.integer_expression(operand, scope)?;
                let result = match operator {
                    UnaryOperator::Not => self.builder.build_not(value, "not"),
                    UnaryOperator::Negate => self.builder.build_int_neg(value, "negate"),
                };
                Ok(result.map_err(builder_error)?.into())
            }

            Expression::Binary { operator, left, right, .. } => {
                Ok(self.binary(*operator, left, right, scope)?.into())
            }

            Expression::If { condition, then_branch, else_branch, .. } => {
                self.if_expression(expression, condition, then_branch, else_branch, scope)
            }

            Expression::Call { callee, arguments, .. } => {
                let function = *self.functions.get(callee).ok_or_else(|| EmitError {
                    message: format!("there is no `{callee}` here"),
                })?;

                // Arguments are given in declaration order — resolve.rs
                // enforced that — but a default may have been skipped, so
                // the parameters are walked and each one either takes the
                // argument written for it or its default.
                let declared = self.parameters_of(callee)?;
                let mut values = Vec::new();
                for parameter in &declared {
                    let written = arguments.iter().find(|given| given.name == parameter.name);
                    let (source, of) = match written {
                        Some(given) => {
                            (&given.value, self.checked_type(&given.value, scope)?)
                        }
                        None => {
                            let default = parameter.default.as_ref().ok_or_else(|| EmitError {
                                message: format!(
                                    "`{}` of `{callee}` has no default, so it must be given",
                                    parameter.name
                                ),
                            })?;
                            (default, self.checked_type(default, scope)?)
                        }
                    };
                    let value = self.expression(source, scope)?;
                    let wanted = self.type_of_name(&parameter.type_name)?;
                    values.push(self.convert_any(value, of, wanted)?.into());
                }

                let call = self
                    .builder
                    .build_call(function, &values, "call")
                    .map_err(builder_error)?;
                call.try_as_basic_value().left().ok_or_else(|| EmitError {
                    message: format!("`{callee}` returns nothing, so it has no value here"),
                })
            }

            // `Point(x: 1, y: 2)` — a struct value built field by field.
            //
            // Built with `insert_value` into an undef rather than stored
            // through a pointer: the value never needs an address, so it
            // can live in registers and needs no allocation at all.
            Expression::Construct { shape, fields, span } => {
                let index = self
                    .shapes
                    .iter()
                    .position(|declared| declared.name == *shape)
                    .ok_or_else(|| EmitError {
                        message: format!("there is no shape called `{shape}`"),
                    })?;
                let declared = self.shapes[index];
                let struct_type = self.shape_type(index)?;

                // Fields go in DECLARED order, not written order. resolve
                // required them to agree, but a skipped default means the
                // two lists differ in length — so the declaration leads.
                let mut value = struct_type.get_undef();
                for (position, field) in declared.fields.iter().enumerate() {
                    let written = fields.iter().find(|given| given.name == field.name);
                    let source = match written {
                        Some(given) => &given.value,
                        None => field.default.as_ref().ok_or_else(|| EmitError {
                            message: format!(
                                "`{}` of `{shape}` has no default, so it must be given",
                                field.name
                            ),
                        })?,
                    };
                    let of = self.checked_type(source, scope)?;
                    let emitted = self.expression(source, scope)?;
                    let wanted = self.type_of_name(&field.type_name)?;
                    let converted = self.convert_any(emitted, of, wanted)?;
                    value = self
                        .builder
                        .build_insert_value(value, converted, position as u32, &field.name)
                        .map_err(builder_error)?
                        .into_struct_value();
                }
                let _ = span;
                Ok(value.into())
            }

            // `p.x` — reading a field, by position.
            Expression::Field { target, name, .. } => {
                let of = self.checked_type(target, scope)?;
                let Type::Shape(index) = of else {
                    return Err(EmitError {
                        message: "only a shape has fields".to_string(),
                    });
                };
                let declared = self.shapes[index];
                let position = declared
                    .fields
                    .iter()
                    .position(|field| field.name == *name)
                    .ok_or_else(|| EmitError {
                        message: format!("`{}` has no field called `{name}`", declared.name),
                    })?;
                let value = self.expression(target, scope)?.into_struct_value();
                self.builder
                    .build_extract_value(value, position as u32, name)
                    .map_err(builder_error)
            }
            // `[1, 2, 3]` — built element by element into an undef, the
            // same way a shape is: the value needs no address, so it
            // never has to touch memory.
            Expression::Array { elements, .. } => {
                let of = self.checked_type(expression, scope)?;
                let Type::Array(entry) = of else {
                    return Err(EmitError {
                        message: "an array literal did not check as an array".to_string(),
                    });
                };
                let info = self.arrays.get(entry).ok_or_else(|| EmitError {
                    message: "an array type outside the unit".to_string(),
                })?;
                let array_type = self.basic(of)?.into_array_type();

                let mut value = array_type.get_undef();
                for (position, element) in elements.iter().enumerate() {
                    let found = self.checked_type(element, scope)?;
                    let emitted = self.expression(element, scope)?;
                    let converted = self.convert_any(emitted, found, info.element)?;
                    value = self
                        .builder
                        .build_insert_value(value, converted, position as u32, "element")
                        .map_err(builder_error)?
                        .into_array_value();
                }
                Ok(value.into())
            }

            // `xs[i]` — reading an element.
            //
            // Through memory, unlike a field: `extract_value` needs a
            // CONSTANT position, and an index is an expression. So the
            // array is spilled to a stack slot and read with a gep.
            // LLVM folds that back into a register when the index turns
            // out to be constant after all.
            Expression::Index { target, index, .. } => {
                let of = self.checked_type(target, scope)?;
                let Type::Array(entry) = of else {
                    return Err(EmitError {
                        message: "only an array can be indexed".to_string(),
                    });
                };
                let info = self.arrays.get(entry).ok_or_else(|| EmitError {
                    message: "an array type outside the unit".to_string(),
                })?;

                let array_type = self.basic(of)?.into_array_type();
                let slot = self
                    .builder
                    .build_alloca(array_type, "array")
                    .map_err(builder_error)?;
                let value = self.expression(target, scope)?;
                self.builder.build_store(slot, value).map_err(builder_error)?;

                let position = self.integer_expression(index, scope)?;
                let position = self.convert(
                    position,
                    self.checked_type(index, scope)?,
                    Type::I64,
                )?;
                let zero = self.context.i64_type().const_zero();
                // Safety: the index is not bounds-checked yet. That is a
                // runtime check with nowhere to report to — recorded in
                // PENDING.md rather than left to be discovered.
                let element = unsafe {
                    self.builder
                        .build_gep(array_type, slot, &[zero, position], "element")
                        .map_err(builder_error)?
                };
                let element_type = self.basic(info.element)?;
                self.builder
                    .build_load(element_type, element, "at")
                    .map_err(builder_error)
            }
        }
    }

    /// A function's parameters as declared, for filling in defaults.
    fn parameters_of(&self, name: &str) -> Result<Vec<&'a Parameter>, EmitError> {
        for item in &self.unit.items {
            if let Item::Function(function) = item {
                if function.name == name {
                    return Ok(function.parameters.iter().collect());
                }
            }
        }
        Err(EmitError {
            message: format!("there is no `{name}` here"),
        })
    }

    fn binary(
        &mut self,
        operator: BinaryOperator,
        left: &Expression,
        right: &Expression,
        scope: &Scope<'context>,
    ) -> Result<IntValue<'context>, EmitError> {
        use BinaryOperator::*;

        // `and` and `or` short-circuit: the right side is not evaluated
        // when the left already decides. Written with blocks rather than
        // a bitwise op because the right side may call a function, and
        // evaluating it anyway would be a visible difference.
        if matches!(operator, And | Or) {
            return self.short_circuit(operator, left, right, scope);
        }

        let left_type = self.checked_type(left, scope)?;
        let right_type = self.checked_type(right, scope)?;
        let left_value = self.integer_expression(left, scope)?;
        let right_value = self.integer_expression(right, scope)?;

        // Both operands meet at the type the checker chose for the
        // operation — the widening rule, made concrete.
        let meeting = match operator {
            Add | Subtract | Multiply | Divide | Remainder => {
                self.checked_type_of_binary(operator, left_type, right_type)
            }
            // A comparison produces bool, so the meeting point is the
            // wider of the two operands rather than the result.
            _ => wider(left_type, right_type),
        };

        let a = self.convert(left_value, left_type, meeting)?;
        let b = self.convert(right_value, right_type, meeting)?;

        let value = match operator {
            Add => self.builder.build_int_add(a, b, "add"),
            Subtract => self.builder.build_int_sub(a, b, "subtract"),
            Multiply => self.builder.build_int_mul(a, b, "multiply"),
            // Signed division and remainder: coordinates are signed, and
            // the unsigned forms would be wrong for every negative one.
            Divide => self.builder.build_int_signed_div(a, b, "divide"),
            Remainder => self.builder.build_int_signed_rem(a, b, "remainder"),
            Equal => self.builder.build_int_compare(IntPredicate::EQ, a, b, "equal"),
            NotEqual => self.builder.build_int_compare(IntPredicate::NE, a, b, "unequal"),
            Less => self.builder.build_int_compare(IntPredicate::SLT, a, b, "less"),
            LessOrEqual => self.builder.build_int_compare(IntPredicate::SLE, a, b, "at-most"),
            Greater => self.builder.build_int_compare(IntPredicate::SGT, a, b, "greater"),
            GreaterOrEqual => self.builder.build_int_compare(IntPredicate::SGE, a, b, "at-least"),
            And | Or => unreachable!("handled above"),
        };
        value.map_err(builder_error)
    }

    fn checked_type_of_binary(&self, _operator: BinaryOperator, left: Type, right: Type) -> Type {
        // Arithmetic is at least i64: two i32 coordinates multiplied
        // overflow i32 at 47 mm by 47 mm.
        match wider(left, right) {
            Type::I32 => Type::I64,
            other => other,
        }
    }

    fn short_circuit(
        &mut self,
        operator: BinaryOperator,
        left: &Expression,
        right: &Expression,
        scope: &Scope<'context>,
    ) -> Result<IntValue<'context>, EmitError> {
        let function = self.current_function();
        let a = self.integer_expression(left, scope)?;
        let decided = self.builder.get_insert_block().expect("inside a block");

        let other = self.context.append_basic_block(function, "other");
        let after = self.context.append_basic_block(function, "after");

        // `and` evaluates the right side only when the left held; `or`
        // only when it did not.
        match operator {
            BinaryOperator::And => self
                .builder
                .build_conditional_branch(a, other, after)
                .map_err(builder_error)?,
            _ => self
                .builder
                .build_conditional_branch(a, after, other)
                .map_err(builder_error)?,
        };

        self.builder.position_at_end(other);
        let b = self.integer_expression(right, scope)?;
        let from_other = self.builder.get_insert_block().expect("inside a block");
        self.builder.build_unconditional_branch(after).map_err(builder_error)?;

        self.builder.position_at_end(after);
        let phi = self
            .builder
            .build_phi(self.context.bool_type(), "shortcut")
            .map_err(builder_error)?;
        phi.add_incoming(&[(&a, decided), (&b, from_other)]);
        Ok(phi.as_basic_value().into_int_value())
    }

    fn if_expression(
        &mut self,
        expression: &Expression,
        condition: &Expression,
        then_branch: &[Statement],
        else_branch: &[Statement],
        scope: &Scope<'context>,
    ) -> Result<BasicValueEnum<'context>, EmitError> {
        // The parser builds each arm as a single `return <expression>`,
        // so there is exactly one expression to find on each side.
        let then_value = arm_expression(then_branch)?;
        let else_value = arm_expression(else_branch)?;

        let then_type = self.checked_type(then_value, scope)?;
        let else_type = self.checked_type(else_value, scope)?;
        // The type the CHECKER gave the whole expression, not one
        // re-derived here. The two used to be computed separately and
        // disagreed for a nested `if`: the checker widened the outer one
        // to match the inner, while this widened only the arms, and the
        // phi ended up claiming a type its operands did not have.
        let meeting = self.checked_type(expression, scope)?;

        let function = self.current_function();
        let test = self.integer_expression(condition, scope)?;

        let then_block = self.context.append_basic_block(function, "then");
        let else_block = self.context.append_basic_block(function, "else");
        let after = self.context.append_basic_block(function, "after");

        self.builder
            .build_conditional_branch(test, then_block, else_block)
            .map_err(builder_error)?;

        self.builder.position_at_end(then_block);
        let a = self.expression(then_value, scope)?;
        let a = self.convert_any(a, then_type, meeting)?;
        let from_then = self.builder.get_insert_block().expect("inside a block");
        self.builder.build_unconditional_branch(after).map_err(builder_error)?;

        self.builder.position_at_end(else_block);
        let b = self.expression(else_value, scope)?;
        let b = self.convert_any(b, else_type, meeting)?;
        let from_else = self.builder.get_insert_block().expect("inside a block");
        self.builder.build_unconditional_branch(after).map_err(builder_error)?;

        self.builder.position_at_end(after);
        let phi = self
            .builder
            .build_phi(self.basic(meeting)?, "if")
            .map_err(builder_error)?;
        phi.add_incoming(&[(&a, from_then), (&b, from_else)]);
        Ok(phi.as_basic_value())
    }
}

fn arm_expression(branch: &[Statement]) -> Result<&Expression, EmitError> {
    match branch.first() {
        Some(Statement::Return { value: Some(value), .. }) => Ok(value),
        _ => Err(EmitError {
            message: "an `if` used as a value needs a value on both sides".to_string(),
        }),
    }
}

fn wider(left: Type, right: Type) -> Type {
    if left.width() >= right.width() {
        left
    } else {
        right
    }
}

fn builder_error(error: inkwell::builder::BuilderError) -> EmitError {
    EmitError {
        message: format!("could not build instruction: {error}"),
    }
}
