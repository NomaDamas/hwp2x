class Hwp2xError(Exception):
    """User-facing application error."""


class ConverterUnavailable(Hwp2xError):
    pass


class ConversionError(Hwp2xError):
    pass


class ComparisonError(Hwp2xError):
    pass


class OptionalDependencyUnavailable(Hwp2xError):
    pass
